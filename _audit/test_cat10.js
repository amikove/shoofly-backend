// Catégorie 10 — Cas limites et concurrence (10.1, 10.2, 10.3).
const { db, api, end } = require('./lib');
const accounts = require('./accounts_s.json');
const o3 = accounts.oeils3;
const o4 = accounts.oeils4;

function iso(hOffset) { return new Date(Date.now() + hOffset * 3600000).toISOString(); }

async function createMission(price, hOffset, extra = {}) {
  const r = await api('POST', '/missions', {
    type: 'immobilier', title: `Cat10 — ${Math.random().toString(36).slice(2, 8)}`, address: '2 avenue Fal Ould Oumeir',
    city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(hOffset), price, property_type: 'appartement', visit_type: 'physique', ...extra,
  }, accounts.client.token);
  if (r.status !== 201) throw new Error('create mission failed: ' + JSON.stringify(r));
  return r.data.mission;
}

async function main() {
  const results = [];

  // ── 10.1 — Double-clic rapide sur validate → une seule action effective ──
  {
    const oeil = accounts.oeils5[0]; // déjà utilisé (5.1 >24h) mais mission différente/nouvelle ici, sans conflit (missions passées non assignées)
    const m = await createMission(300, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, oeil.token);
    await api('POST', `/missions/${m.id}/hire/${oeil.id}`, {}, accounts.client.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'en_route' }, oeil.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'active' }, oeil.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'completed' }, oeil.token);

    const balanceBefore = parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil.id]))[0].balance);
    // Deux appels /validate strictement concurrents (Promise.all, pas séquentiel)
    const [r1, r2] = await Promise.all([
      api('POST', `/missions/${m.id}/validate`, {}, accounts.client.token),
      api('POST', `/missions/${m.id}/validate`, {}, accounts.client.token),
    ]);
    const balanceAfter = parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil.id]))[0].balance);
    const [mRow] = await db('SELECT oeil_earning FROM missions WHERE id=$1', [m.id]);
    const [{ n: wtCount }] = await db(`SELECT COUNT(*)::int AS n FROM wallet_transactions WHERE mission_id=$1 AND user_id=$2`, [m.id, oeil.id]);
    const delta = Math.round((balanceAfter - balanceBefore) * 100) / 100;

    results.push({
      scenario: '10.1 — Double-clic (2 appels /validate strictement concurrents) → une seule action effective',
      expected: `exactement 1 des 2 réussit (HTTP 200), l'autre échoue proprement (409/400), 1 SEULE ligne wallet_transactions, delta balance = oeil_earning exact (${mRow.oeil_earning}), PAS le double`,
      observed: `r1=HTTP ${r1.status}, r2=HTTP ${r2.status}, lignes wallet=${wtCount}, delta balance=+${delta}`,
      ok: [r1.status, r2.status].filter(s => s === 200).length === 1 && [r1.status, r2.status].filter(s => s !== 200).length === 1
        && wtCount === 1 && delta === parseFloat(mRow.oeil_earning),
    });
  }

  // ── 10.2 — Deux admins simultanés : l'un annule, l'autre assigne ─────────
  {
    const oeil = accounts.oeils5[1];
    const m = await createMission(300, 24); // mission encore 'pending' (pas embauchée)
    const ri = await api('POST', `/missions/${m.id}/interest`, {}, oeil.token);
    if (ri.status !== 201) throw new Error('10.2 interest failed: ' + JSON.stringify(ri));

    const [rCancel, rAssign] = await Promise.all([
      api('POST', `/missions/${m.id}/status`, { status: 'cancelled' }, accounts.admin.token),
      api('POST', `/missions/${m.id}/assign-admin`, { oeil_id: oeil.id }, accounts.admin.token),
    ]);
    const [mRow] = await db('SELECT status, oeil_id, cancelled_at FROM missions WHERE id=$1', [m.id]);

    const isConsistent = (mRow.status === 'cancelled' && mRow.oeil_id === null)
      || (mRow.status === 'assigned' && mRow.oeil_id === oeil.id && mRow.cancelled_at === null);

    results.push({
      scenario: "10.2 — Deux admins simultanés sur la même mission (l'un annule, l'autre assigne) → pas d'état incohérent",
      expected: "état final cohérent : SOIT cancelled (oeil_id=NULL), SOIT assigned (oeil_id défini, cancelled_at=NULL) — jamais les deux à la fois",
      observed: `cancel=HTTP ${rCancel.status}, assign=HTTP ${rAssign.status}, état final: status=${mRow.status}, oeil_id=${mRow.oeil_id}, cancelled_at=${mRow.cancelled_at}`,
      ok: isConsistent,
    });
  }

  // ── 10.3 — Œil désactivé (is_active=false) avec mission en cours ─────────
  {
    const oeil = accounts.oeils5[2];
    const m = await createMission(300, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, oeil.token);
    await api('POST', `/missions/${m.id}/hire/${oeil.id}`, {}, accounts.client.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'en_route' }, oeil.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'active' }, oeil.token);

    // Admin désactive le compte (is_active=false) — via toggle-active
    const rToggle = await api('PUT', `/users/admin/${oeil.id}/toggle-active`, {}, accounts.admin.token);
    const [uAfter] = await db('SELECT is_active FROM users WHERE id=$1', [oeil.id]);

    // L'Œil tente d'agir sur SA PROPRE mission en cours (terminer) — doit être bloqué par auth
    const rTryComplete = await api('POST', `/missions/${m.id}/status`, { status: 'completed' }, oeil.token);

    const [mRow] = await db('SELECT status, oeil_id FROM missions WHERE id=$1', [m.id]);
    const [relEvents] = await db('SELECT COUNT(*)::int AS n FROM reliability_events WHERE oeil_id=$1', [oeil.id]);
    const [wtDebit] = await db(`SELECT COUNT(*)::int AS n FROM wallet_transactions WHERE mission_id=$1 AND type='debit'`, [m.id]);

    results.push({
      scenario: "10.3 — Œil désactivé (is_active=false) alors qu'une mission est EN COURS (active) : réaffectation automatique et absence de pénalité",
      expected: "un mécanisme réaffecte automatiquement la mission à un autre Œil, sans pénalité pour celui désactivé",
      observed: `toggle HTTP ${rToggle.status} (is_active=${uAfter.is_active}), Œil bloqué par auth (tentative status→completed): HTTP ${rTryComplete.status} "${rTryComplete.data?.error}", mission INCHANGÉE: status=${mRow.status} oeil_id=${mRow.oeil_id === oeil.id ? '(toujours le même Œil, mission non réaffectée)' : mRow.oeil_id}, événements fiabilité=${relEvents.n}, débit wallet=${wtDebit.n}`,
      ok: false, // constaté ci-dessous : aucun mécanisme de réaffectation automatique n'existe dans le code pour ce cas précis (mission déjà 'active', pas seulement 'assigned')
      diagnostic: "Aucun cron ni route ne surveille les missions actives dont l'Œil assigné a is_active=false. La mission reste bloquée indéfiniment (l'Œil ne peut plus agir dessus, aucune autre logique ne la reprend) jusqu'à intervention manuelle d'un admin. Le cron H+30 (late-start) existe mais ne couvre QUE les missions encore au statut 'assigned' (pas encore démarrées) et applique une pénalité de -100 MAD + -20 fiabilité à l'Œil — ce qui contredirait 'aucune pénalité pour lui' si l'Œil avait simplement été désactivé sans faute de sa part. Absence de fonctionnalité plutôt que bug d'une fonctionnalité existante — signalé pour décision produit plutôt que corrigé unilatéralement dans ce passage.",
    });
  }

  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results_cat10.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} OK`);
  if (failed.length) console.log('ÉCHECS/OBSERVATIONS:', JSON.stringify(failed, null, 2));
  await end();
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
