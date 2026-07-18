// Catégorie 2.1-2.5 — Annulations client et admin (pas de dépendance cron).
const { db, api, end } = require('./lib');
const accounts = require('./accounts_s.json');

function iso(hOffset) { return new Date(Date.now() + hOffset * 3600000).toISOString(); }

async function createMission(price, hOffset, extra = {}) {
  const r = await api('POST', '/missions', {
    type: 'immobilier', title: `Scénario cat2 — ${Math.random().toString(36).slice(2, 8)}`, address: '5 avenue Hassan II',
    city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(hOffset), price, property_type: 'appartement', visit_type: 'physique', ...extra,
  }, accounts.client.token);
  if (r.status !== 201) throw new Error('create mission failed: ' + JSON.stringify(r));
  return r.data.mission;
}

async function hire(missionId, oeilToken, oeilId) {
  let r = await api('POST', `/missions/${missionId}/interest`, {}, oeilToken);
  if (r.status !== 201) throw new Error('interest failed: ' + JSON.stringify(r));
  r = await api('POST', `/missions/${missionId}/hire/${oeilId}`, {}, accounts.client.token);
  if (r.status !== 200) throw new Error('hire failed: ' + JSON.stringify(r));
  return r.data.mission;
}

async function clientBalance() {
  const [row] = await db('SELECT balance FROM users WHERE id=$1', [accounts.client.id]);
  return parseFloat(row.balance);
}

async function cancelViaStatus(missionId, token, extraBody = {}) {
  return api('POST', `/missions/${missionId}/status`, { status: 'cancelled', ...extraBody }, token);
}

async function main() {
  const results = [];

  // ── 2.1 — Client annule AVANT assignation → 100% ──────────
  {
    const price = 300;
    const before = await clientBalance();
    const m = await createMission(price, 24);
    const r = await cancelViaStatus(m.id, accounts.client.token);
    if (r.status !== 200) throw new Error('2.1 cancel failed: ' + JSON.stringify(r));
    const after = await clientBalance();
    const delta = Math.round((after - before) * 100) / 100;
    const [wt] = await db(`SELECT type, amount, reason FROM wallet_transactions WHERE mission_id=$1`, [m.id]);
    results.push({
      scenario: '2.1 — Client annule AVANT assignation',
      expected: `remboursement 100% = ${price}.00, reason="Remboursement annulation avant assignation"`,
      observed: `delta=+${delta}, wallet: ${wt?.type} ${wt?.amount} (${wt?.reason})`,
      ok: delta === price && wt?.type === 'credit' && parseFloat(wt?.amount) === price && wt?.reason === 'Remboursement annulation avant assignation',
    });
  }

  // ── 2.2 — Client annule, assignée, >2h avant → refund_partial_rate (50% défaut) ──
  {
    const price = 300;
    const before = await clientBalance();
    const m = await createMission(price, 3); // scheduled_at = now+3h (>2h threshold)
    await hire(m.id, accounts.oeils[1].token, accounts.oeils[1].id);
    const r = await cancelViaStatus(m.id, accounts.client.token);
    if (r.status !== 200) throw new Error('2.2 cancel failed: ' + JSON.stringify(r));
    const after = await clientBalance();
    const delta = Math.round((after - before) * 100) / 100;
    const expected = Math.round(price * 0.5 * 100) / 100; // refund_partial_rate défaut = 0.5
    const [wt] = await db(`SELECT type, amount, reason FROM wallet_transactions WHERE mission_id=$1`, [m.id]);
    results.push({
      scenario: '2.2 — Client annule assignée >2h avant (taux défaut 50%)',
      expected: `remboursement = price×0.5 = ${expected}, reason="Remboursement annulation (50%)"`,
      observed: `delta=+${delta}, wallet: ${wt?.type} ${wt?.amount} (${wt?.reason})`,
      ok: delta === expected && parseFloat(wt?.amount) === expected && wt?.reason === 'Remboursement annulation (50%)',
    });
  }

  // ── 2.3 — Client annule, assignée, <2h avant → 0% ─────────
  {
    const price = 300;
    const before = await clientBalance();
    const m = await createMission(price, 1); // scheduled_at = now+1h (<2h threshold)
    await hire(m.id, accounts.oeils[2].token, accounts.oeils[2].id);
    const r = await cancelViaStatus(m.id, accounts.client.token);
    if (r.status !== 200) throw new Error('2.3 cancel failed: ' + JSON.stringify(r));
    const after = await clientBalance();
    const delta = Math.round((after - before) * 100) / 100;
    const [wt] = await db(`SELECT type, amount, reason FROM wallet_transactions WHERE mission_id=$1`, [m.id]);
    results.push({
      scenario: '2.3 — Client annule assignée <2h avant',
      expected: 'remboursement = 0.00, aucune ligne wallet_transactions',
      observed: `delta=+${delta}, wallet row=${wt ? JSON.stringify(wt) : 'aucune'}`,
      ok: delta === 0 && !wt,
    });
  }

  // ── 2.4 — Admin annule SANS client_at_fault → 100% peu importe timing ──
  {
    const price = 350;
    const before = await clientBalance();
    const m = await createMission(price, 0.5); // <2h avant — si la faute était imputée au client, ce serait 0%
    await hire(m.id, accounts.oeils[3].token, accounts.oeils[3].id);
    const r = await cancelViaStatus(m.id, accounts.admin.token); // pas de client_at_fault dans le body
    if (r.status !== 200) throw new Error('2.4 cancel failed: ' + JSON.stringify(r));
    const after = await clientBalance();
    const delta = Math.round((after - before) * 100) / 100;
    const [wt] = await db(`SELECT type, amount, reason FROM wallet_transactions WHERE mission_id=$1`, [m.id]);
    results.push({
      scenario: '2.4 — Admin annule SANS client_at_fault (<2h avant)',
      expected: `remboursement 100% = ${price} malgré <2h, reason="Remboursement intégral — annulation non imputable au client"`,
      observed: `delta=+${delta}, wallet: ${wt?.type} ${wt?.amount} (${wt?.reason})`,
      ok: delta === price && parseFloat(wt?.amount) === price && wt?.reason === 'Remboursement intégral — annulation non imputable au client',
    });
  }

  // ── 2.5 — Admin annule AVEC client_at_fault=true → même grille que 2.2/2.3 ──
  // 2.5a : >2h avant
  {
    const price = 300;
    const before = await clientBalance();
    const m = await createMission(price, 3);
    await hire(m.id, accounts.oeils[4].token, accounts.oeils[4].id);
    const r = await cancelViaStatus(m.id, accounts.admin.token, { client_at_fault: true });
    if (r.status !== 200) throw new Error('2.5a cancel failed: ' + JSON.stringify(r));
    const after = await clientBalance();
    const delta = Math.round((after - before) * 100) / 100;
    const expected = Math.round(price * 0.5 * 100) / 100;
    results.push({
      scenario: '2.5a — Admin annule AVEC client_at_fault=true, >2h avant',
      expected: `remboursement = price×0.5 = ${expected} (même grille que 2.2)`,
      observed: `delta=+${delta}`,
      ok: delta === expected,
    });
  }
  // 2.5b : <2h avant
  {
    const price = 300;
    const before = await clientBalance();
    const m = await createMission(price, 1);
    await hire(m.id, accounts.oeils[0].token, accounts.oeils[0].id);
    const r = await cancelViaStatus(m.id, accounts.admin.token, { client_at_fault: true });
    if (r.status !== 200) throw new Error('2.5b cancel failed: ' + JSON.stringify(r));
    const after = await clientBalance();
    const delta = Math.round((after - before) * 100) / 100;
    results.push({
      scenario: '2.5b — Admin annule AVEC client_at_fault=true, <2h avant',
      expected: 'remboursement = 0.00 (même grille que 2.3)',
      observed: `delta=+${delta}`,
      ok: delta === 0,
    });
  }

  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results_cat2_client_admin.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} OK`);
  if (failed.length) console.log('ÉCHECS:', JSON.stringify(failed, null, 2));
  await end();
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
