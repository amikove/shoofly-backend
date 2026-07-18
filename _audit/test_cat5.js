// Catégorie 5 — Fiabilité et suspension (5.1-5.5).
const { db, api, setSetting, end } = require('./lib');
const accounts = require('./accounts_s.json');
const o4 = accounts.oeils4;

function iso(hOffset) { return new Date(Date.now() + hOffset * 3600000).toISOString(); }

async function createMission(price, hOffset, extra = {}) {
  const r = await api('POST', '/missions', {
    type: 'immobilier', title: `Cat5 — ${Math.random().toString(36).slice(2, 8)}`, address: '4 rue Zerktouni',
    city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(hOffset), price, property_type: 'appartement', visit_type: 'physique', ...extra,
  }, accounts.client.token);
  if (r.status !== 201) throw new Error('create mission failed: ' + JSON.stringify(r));
  return r.data.mission;
}

async function hireAndRefuse(oeil, hOffset) {
  const m = await createMission(300, hOffset);
  const ri = await api('POST', `/missions/${m.id}/interest`, {}, oeil.token);
  if (ri.status !== 201) throw new Error('interest failed: ' + JSON.stringify(ri));
  const rh = await api('POST', `/missions/${m.id}/hire/${oeil.id}`, {}, accounts.client.token);
  if (rh.status !== 200) throw new Error('hire failed: ' + JSON.stringify(rh));
  const rr = await api('POST', `/missions/${m.id}/refuse`, {}, oeil.token);
  if (rr.status !== 200) throw new Error('refuse failed: ' + JSON.stringify(rr));
  return m;
}

async function main() {
  const results = [];

  // ── 5.1 — Refus à 3 délais différents → -15 / -35 / -50 exacts ───────────
  {
    const cases = [
      { oeil: o4[0], hOffset: 48, expected: -15, label: '>24h avant' },
      { oeil: o4[1], hOffset: 10, expected: -35, label: 'entre 2h et 24h avant' },
      { oeil: o4[2], hOffset: 1, expected: -50, label: '<2h avant' },
    ];
    for (const c of cases) {
      const m = await hireAndRefuse(c.oeil, c.hOffset);
      const [rel] = await db('SELECT points, reason, is_grave FROM reliability_events WHERE oeil_id=$1 AND mission_id=$2', [c.oeil.id, m.id]);
      results.push({
        scenario: `5.1 — Refus ${c.label}`,
        expected: `${c.expected} points, is_grave=${c.expected <= -35}`,
        observed: `${rel.points} points (${rel.reason}), is_grave=${rel.is_grave}`,
        ok: rel.points === c.expected && rel.is_grave === (c.expected <= -35),
      });
    }
  }

  // ── 5.2 — Score sous 50% → suspension auto + mode=available liste vide (pas 403) ──
  // Note méthodologique : /refuse pose lui-même un cooldown de 4h (transfer_cooldown_hours),
  // ce qui empêche empiriquement d'enchaîner 10 refus via l'API en peu de temps (l'Œil est
  // bloqué dès le 2e /interest — constaté, pas un bug : anti-abus cohérent). Le montant exact
  // de la pénalité de refus est déjà prouvé en 5.1 ; ici on isole le SEUIL de suspension via
  // logReliabilityEvent directement (même montant -50/-10 clampé que le vrai /refuse <2h).
  {
    const oeil = o4[3];
    const { logReliabilityEvent } = require('../src/utils/reliabilityScore');
    const { getDb } = require('../src/db/schema');
    const realDb = getDb();
    for (let i = 0; i < 10; i++) {
      // Appelle la VRAIE fonction serveur (même code que /refuse <2h invoquerait), juste sans
      // passer par 10 allers-retours HTTP bloqués par le cooldown de 4h posé par /refuse lui-même.
      await logReliabilityEvent(realDb, oeil.id, null, -50, `Mission assignée refusée par l'Œil (moins de 2h avant, très tardif) — simulation 5.2 #${i + 1}`, true);
    }
    const [u] = await db('SELECT reliability_score, is_suspended FROM users WHERE id=$1', [oeil.id]);
    const [{ n: eventCount }] = await db('SELECT COUNT(*)::int AS n FROM reliability_events WHERE oeil_id=$1', [oeil.id]);

    const rAvail = await api('GET', '/missions?mode=available', undefined, oeil.token);

    results.push({
      scenario: '5.2 — 10 refus <2h → score sous 50%, suspension auto, mode=available renvoie liste vide (pas 403)',
      expected: `${eventCount} événements, score final=0 (10×-10 clampé, floor levé à 10 missions), is_suspended=true, GET ?mode=available → HTTP 200 liste vide`,
      observed: `score=${u.reliability_score}, is_suspended=${u.is_suspended}, mode=available → HTTP ${rAvail.status}, missions.length=${rAvail.data?.missions?.length}`,
      ok: u.is_suspended === true && u.reliability_score < 50 && rAvail.status === 200 && Array.isArray(rAvail.data?.missions) && rAvail.data.missions.length === 0,
    });
    results.s52oeilId = oeil.id;
  }

  // ── 5.3 — Réintégration à un score cible, PUIS non-rechute sous 50% après un événement positif ──
  {
    const oeil = o4[4];
    // Suspendre directement en base (10 événements -50 comme 5.2, sans repasser par autant d'appels HTTP)
    for (let i = 0; i < 10; i++) {
      await db(`INSERT INTO reliability_events (oeil_id, points, reason, is_grave) VALUES ($1, -10, 'Setup suspension pour test 5.3', true)`, [oeil.id]);
    }
    await db(`UPDATE users SET reliability_score=0, is_suspended=true, suspended_at=NOW(), suspended_reason='Setup test' WHERE id=$1`, [oeil.id]);

    const targetScore = 65;
    const rReact = await api('POST', `/reliability/admin/${oeil.id}/reactivate`, { reset_score: targetScore }, accounts.admin.token);
    const [u1] = await db('SELECT reliability_score, is_suspended FROM users WHERE id=$1', [oeil.id]);

    results.push({
      scenario: '5.3a — Réintégration admin avec score cible exact',
      expected: `HTTP 200, reliability_score=${targetScore} exact, is_suspended=false`,
      observed: `HTTP ${rReact.status}, score=${u1.reliability_score}, is_suspended=${u1.is_suspended}`,
      ok: rReact.status === 200 && u1.reliability_score === targetScore && u1.is_suspended === false,
    });

    // Événement positif ultérieur (note 5/5 = +10) — ne doit PAS faire rechuter sous 50%
    const m = await createMission(300, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, oeil.token);
    await api('POST', `/missions/${m.id}/hire/${oeil.id}`, {}, accounts.client.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'en_route' }, oeil.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'active' }, oeil.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'completed' }, oeil.token);
    const rRate = await api('POST', `/missions/${m.id}/rate`, { score: 5 }, accounts.client.token);
    const [u2] = await db('SELECT reliability_score, is_suspended FROM users WHERE id=$1', [oeil.id]);

    results.push({
      scenario: '5.3b — Note 5/5 après réintégration → NE fait PAS rechuter sous 50% (bug historique reconfirmé absent)',
      expected: 'reliability_score reste ≥ 50, is_suspended=false (l\'historique pré-reset est ignoré grâce à is_reset)',
      observed: `HTTP rate=${rRate.status}, score après note 5/5=${u2.reliability_score}, is_suspended=${u2.is_suspended}`,
      ok: rRate.status === 201 && u2.reliability_score >= 50 && u2.is_suspended === false,
    });
  }

  // ── 5.4 — Œil <10 missions : badge "Nouveau" au client, score réel à lui-même/admin ──
  {
    const oeil = o4[5];
    const rClient = await api('GET', `/users/oeils/${oeil.id}`, undefined, accounts.client.token);
    const rSelf = await api('GET', `/users/oeils/${oeil.id}`, undefined, oeil.token);
    const rAdmin = await api('GET', `/users/oeils/${oeil.id}`, undefined, accounts.admin.token);
    results.push({
      scenario: '5.4 — Œil <10 missions : badge Nouveau (score masqué) pour le client, score réel pour lui-même et l\'admin',
      expected: 'is_new_oeil=true dans les 3 cas ; reliability_score=null pour le client, valeur réelle pour lui-même ET admin',
      observed: `client: is_new_oeil=${rClient.data?.is_new_oeil}, reliability_score=${rClient.data?.reliability_score} | self: reliability_score=${rSelf.data?.reliability_score} | admin: reliability_score=${rAdmin.data?.reliability_score}`,
      ok: rClient.data?.is_new_oeil === true && rClient.data?.reliability_score === null
        && rSelf.data?.reliability_score !== null && rSelf.data?.reliability_score !== undefined
        && rAdmin.data?.reliability_score !== null && rAdmin.data?.reliability_score !== undefined,
    });
  }

  // ── 5.5 — Bonus qualité 5 étoiles actif : montant exact + dépense Marketing ──
  {
    await setSetting('five_star_bonus_active', 'true', accounts.admin.token);
    await setSetting('five_star_bonus_percent', '10', accounts.admin.token);

    const oeil = o4[5]; // réutilisé, une mission de plus ne change rien au test
    const price = 500;
    const m = await createMission(price, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, oeil.token);
    await api('POST', `/missions/${m.id}/hire/${oeil.id}`, {}, accounts.client.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'en_route' }, oeil.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'active' }, oeil.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'completed' }, oeil.token);

    const balanceBefore = parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil.id]))[0].balance);
    const expenseCountBefore = (await db(`SELECT COUNT(*)::int AS n FROM expenses WHERE category='Marketing'`))[0].n;

    const [mRow] = await db('SELECT oeil_earning FROM missions WHERE id=$1', [m.id]);
    const oeilEarning = parseFloat(mRow.oeil_earning);
    const expectedBonus = Math.round(oeilEarning * 0.10 * 100) / 100;

    const rRate = await api('POST', `/missions/${m.id}/rate`, { score: 5 }, accounts.client.token);

    const balanceAfter = parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil.id]))[0].balance);
    const [expense] = await db(`SELECT amount, category, description FROM expenses WHERE category='Marketing' ORDER BY id DESC LIMIT 1`);
    const expenseCountAfter = (await db(`SELECT COUNT(*)::int AS n FROM expenses WHERE category='Marketing'`))[0].n;
    const [wt] = await db(`SELECT amount, reason FROM wallet_transactions WHERE mission_id=$1 AND reason LIKE '%Bonus qualité%'`, [m.id]);

    results.push({
      scenario: '5.5 — Bonus qualité 5 étoiles actif : montant exact crédité + dépense Marketing correspondante',
      expected: `bonus = oeil_earning(${oeilEarning}) × 10% = ${expectedBonus} exact, delta balance = +${expectedBonus} (au-delà du paiement normal), 1 nouvelle dépense Marketing de ${expectedBonus}`,
      observed: `HTTP rate=${rRate.status}, delta balance=${Math.round((balanceAfter - balanceBefore) * 100) / 100}, wallet bonus=${wt?.amount} (${wt?.reason}), dépenses Marketing avant/après=${expenseCountBefore}/${expenseCountAfter}, dernière dépense=${expense?.amount}`,
      ok: rRate.status === 201 && parseFloat(wt?.amount) === expectedBonus && expenseCountAfter === expenseCountBefore + 1 && parseFloat(expense?.amount) === expectedBonus,
    });

    await setSetting('five_star_bonus_active', 'false', accounts.admin.token);
  }

  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results_cat5.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => r && !r.ok);
  console.log(`\n${results.filter(r=>r&&r.scenario).length - failed.length}/${results.filter(r=>r&&r.scenario).length} OK`);
  if (failed.length) console.log('ÉCHECS:', JSON.stringify(failed, null, 2));
  await end();
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
