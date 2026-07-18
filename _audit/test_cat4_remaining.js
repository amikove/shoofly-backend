// Catégorie 4 — 4.1, 4.2, 4.3, 4.5, 4.6 (pas de dépendance cron).
const { db, api, end } = require('./lib');
const accounts = require('./accounts_s.json');

function iso(hOffset) { return new Date(Date.now() + hOffset * 3600000).toISOString(); }
const o3 = accounts.oeils3;

async function createMission(price, hOffset, extra = {}) {
  const r = await api('POST', '/missions', {
    type: 'immobilier', title: `Cat4 — ${Math.random().toString(36).slice(2, 8)}`, address: '7 rue Ibn Sina',
    city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(hOffset), price, property_type: 'appartement', visit_type: 'physique', ...extra,
  }, accounts.client.token);
  if (r.status !== 201) throw new Error('create mission failed: ' + JSON.stringify(r));
  return r.data.mission;
}

async function walletCount() {
  const [row] = await db('SELECT COUNT(*)::int AS n FROM wallet_transactions');
  return row.n;
}

async function main() {
  const results = [];

  // ── 4.1 — Mission pending, client modifie → application immédiate ────────
  {
    const m = await createMission(300, 24);
    const r = await api('PUT', `/missions/${m.id}`, { title: 'Titre modifié immédiatement — 4.1', address: 'Nouvelle adresse 4.1' }, accounts.client.token);
    results.push({
      scenario: '4.1 — Mission pending, client modifie → application immédiate',
      expected: 'HTTP 200, applied=true, titre/adresse mis à jour immédiatement, pas de mission_edit_requests créée',
      observed: `HTTP ${r.status}, applied=${r.data?.applied}, titre="${r.data?.mission?.title}"`,
      ok: r.status === 200 && r.data.applied === true && r.data.mission.title === 'Titre modifié immédiatement — 4.1',
    });
  }

  // ── 4.2 — Mission assigned, Œil APPROUVE → appliqué, aucune pénalité, aucun mouvement financier ──
  {
    const oeil = o3[2]; // transféré 'before' (3.1) mais plus assigné nulle part, aucun cooldown ni conflit de créneau
    const m = await createMission(300, 24);
    const ri = await api('POST', `/missions/${m.id}/interest`, {}, oeil.token);
    if (ri.status !== 201) throw new Error('4.2 interest failed: ' + JSON.stringify(ri));
    const rh = await api('POST', `/missions/${m.id}/hire/${oeil.id}`, {}, accounts.client.token);
    if (rh.status !== 200) throw new Error('4.2 hire failed: ' + JSON.stringify(rh));

    const [relBefore] = await db('SELECT COUNT(*)::int AS n FROM reliability_events WHERE oeil_id=$1', [oeil.id]);
    const walletBefore = await walletCount();

    const re = await api('PUT', `/missions/${m.id}`, { title: 'Titre modifié après approbation — 4.2' }, accounts.client.token);
    if (re.status !== 202) throw new Error('4.2 edit-request failed: ' + JSON.stringify(re));
    const ra = await api('POST', `/missions/edit-requests/${re.data.edit_request.id}/approve`, {}, oeil.token);

    const [relAfter] = await db('SELECT COUNT(*)::int AS n FROM reliability_events WHERE oeil_id=$1', [oeil.id]);
    const walletAfter = await walletCount();
    const [mRow] = await db('SELECT title, status, oeil_id FROM missions WHERE id=$1', [m.id]);

    results.push({
      scenario: '4.2 — Mission assigned, client modifie, Œil APPROUVE → changements appliqués, AUCUNE pénalité, AUCUN mouvement financier',
      expected: `titre appliqué="Titre modifié après approbation — 4.2", status reste assigned, reliability_events count inchangé (${relBefore.n}), wallet_transactions count inchangé (${walletBefore})`,
      observed: `HTTP approve=${ra.status}, titre="${mRow.title}", status=${mRow.status}, oeil_id inchangé=${mRow.oeil_id === oeil.id}, reliability_events=${relAfter.n}, wallet_transactions=${walletAfter}`,
      ok: ra.status === 200 && mRow.title === 'Titre modifié après approbation — 4.2' && mRow.status === 'assigned' && mRow.oeil_id === oeil.id
        && relAfter.n === relBefore.n && walletAfter === walletBefore,
    });
  }

  // ── 4.3 — Mission assigned, Œil REFUSE → pending/oeil_id=NULL même id, aucune pénalité ──
  {
    const oeil = o3[5]; // transféré 'before' (3.2) mais plus assigné nulle part, aucun cooldown ni conflit de créneau
    const m = await createMission(300, 24);
    const ri = await api('POST', `/missions/${m.id}/interest`, {}, oeil.token);
    if (ri.status !== 201) throw new Error('4.3 interest failed: ' + JSON.stringify(ri));
    const rh = await api('POST', `/missions/${m.id}/hire/${oeil.id}`, {}, accounts.client.token);
    if (rh.status !== 200) throw new Error('4.3 hire failed: ' + JSON.stringify(rh));

    const [relBefore] = await db('SELECT COUNT(*)::int AS n FROM reliability_events WHERE oeil_id=$1', [oeil.id]);

    const re = await api('PUT', `/missions/${m.id}`, { title: 'Tentative modif refusée — 4.3' }, accounts.client.token);
    if (re.status !== 202) throw new Error('4.3 edit-request failed: ' + JSON.stringify(re));
    const rr = await api('POST', `/missions/edit-requests/${re.data.edit_request.id}/reject`, {}, oeil.token);

    const [relAfter] = await db('SELECT COUNT(*)::int AS n FROM reliability_events WHERE oeil_id=$1', [oeil.id]);
    const [mRow] = await db('SELECT id, title, status, oeil_id FROM missions WHERE id=$1', [m.id]);

    results.push({
      scenario: '4.3 — Mission assigned, client modifie, Œil REFUSE → repasse pending/oeil_id=NULL (même id), aucune pénalité',
      expected: `même id mission (${m.id}), status=pending, oeil_id=NULL, titre INCHANGÉ (proposition rejetée, pas appliquée), reliability_events inchangé (${relBefore.n})`,
      observed: `HTTP reject=${rr.status}, id=${mRow.id}, status=${mRow.status}, oeil_id=${mRow.oeil_id}, titre="${mRow.title}", reliability_events=${relAfter.n}`,
      ok: rr.status === 200 && mRow.id === m.id && mRow.status === 'pending' && mRow.oeil_id === null
        && mRow.title !== 'Tentative modif refusée — 4.3' && relAfter.n === relBefore.n,
    });
  }

  // ── 4.5 — Tentative de modifier price/type/subcategory → rejeté 400 ───────
  {
    const m = await createMission(300, 24);
    const rPrice = await api('PUT', `/missions/${m.id}`, { price: 999 }, accounts.client.token);
    const rType = await api('PUT', `/missions/${m.id}`, { type: 'audit' }, accounts.client.token);
    const rSub = await api('PUT', `/missions/${m.id}`, { subcategory: 'quelquechose' }, accounts.client.token);
    results.push({
      scenario: '4.5 — Tentative de modifier price/type/subcategory → rejeté 400',
      expected: 'HTTP 400 pour les 3 tentatives, "Champs non modifiables après création"',
      observed: `price: HTTP ${rPrice.status} (${rPrice.data?.error}), type: HTTP ${rType.status}, subcategory: HTTP ${rSub.status}`,
      ok: rPrice.status === 400 && rType.status === 400 && rSub.status === 400
        && [rPrice, rType, rSub].every(r => /non modifiables/i.test(r.data?.error || '')),
    });
  }

  // ── 4.6 — Tentative de 2e demande pendant qu'une est en attente → rejeté 409 ──
  {
    const oeil = o3[7]; // transféré 'before' (3.3) mais plus assigné nulle part, aucun cooldown ni conflit de créneau
    const m = await createMission(300, 24);
    const ri = await api('POST', `/missions/${m.id}/interest`, {}, oeil.token);
    if (ri.status !== 201) throw new Error('4.6 interest failed: ' + JSON.stringify(ri));
    const rh = await api('POST', `/missions/${m.id}/hire/${oeil.id}`, {}, accounts.client.token);
    if (rh.status !== 200) throw new Error('4.6 hire failed: ' + JSON.stringify(rh));

    const re1 = await api('PUT', `/missions/${m.id}`, { title: 'Première demande — 4.6' }, accounts.client.token);
    const re2 = await api('PUT', `/missions/${m.id}`, { title: 'Deuxième demande concurrente — 4.6' }, accounts.client.token);
    results.push({
      scenario: '4.6 — Tentative de 2e demande de modification pendant qu\'une est en attente → rejeté 409',
      expected: 'HTTP 202 (1ère), puis HTTP 409 "Une demande de modification est déjà en attente" (2e)',
      observed: `1ère: HTTP ${re1.status}, 2e: HTTP ${re2.status} (${re2.data?.error})`,
      ok: re1.status === 202 && re2.status === 409 && /déjà en attente/i.test(re2.data?.error || ''),
    });
  }

  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results_cat4_remaining.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} OK`);
  if (failed.length) console.log('ÉCHECS:', JSON.stringify(failed, null, 2));
  await end();
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
