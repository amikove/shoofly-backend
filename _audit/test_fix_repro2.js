// Re-test v2 — timing calé précisément sur le prochain tick cron */30min (19:30 UTC)
// au lieu de "maintenant - X min" (qui rate la fenêtre si le tick suivant n'est pas dans
// la minute qui suit, cause de l'échec du premier essai).
const { db, api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');

async function step(label, r) {
  console.log(label, r.status, JSON.stringify(r.data && r.data.mission ? { id: r.data.mission.id, status: r.data.mission.status } : r.data));
  if (r.status >= 400) throw new Error(`${label} failed`);
  return r.data;
}

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;
  const TARGET_TICK = new Date('2026-07-17T19:30:00.000Z');

  await setSetting('late_start_alert_window_minutes', '1', admin.token);
  await setSetting('late_start_auto_transfer_minutes', '2', admin.token);

  const regA = await api('POST', '/auth/register', { email: `audit2_fix2A_${Date.now()}@test.local`, password: 'Test1234!', first_name: 'Fix2A', last_name: 'Test', role: 'oeil', city: 'Casablanca' });
  const oeilA = { token: regA.data.token, id: regA.data.user.id };
  await db(`UPDATE oeil_profiles SET is_verified=true, is_available=true WHERE user_id=$1`, [oeilA.id]);

  const regB = await api('POST', '/auth/register', { email: `audit2_fix2B_${Date.now()}@test.local`, password: 'Test1234!', first_name: 'Fix2B', last_name: 'Test', role: 'oeil', city: 'Casablanca' });
  const oeilB = { token: regB.data.token, id: regB.data.user.id };
  await db(`UPDATE oeil_profiles SET is_verified=true, is_available=true WHERE user_id=$1`, [oeilB.id]);
  const fundC = await step('fundB create', await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit fix2 repro — funding B', address: '1 rue M', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + 3 * 3600 * 1000).toISOString(), price: 175,
  }, client.token));
  await step('fundB interest', await api('POST', `/missions/${fundC.mission.id}/interest`, {}, oeilB.token));
  await step('fundB hire', await api('POST', `/missions/${fundC.mission.id}/hire/${oeilB.id}`, {}, client.token));
  await step('fundB en_route', await api('POST', `/missions/${fundC.mission.id}/status`, { status: 'en_route' }, oeilB.token));
  await step('fundB active', await api('POST', `/missions/${fundC.mission.id}/status`, { status: 'active' }, oeilB.token));
  await step('fundB completed', await api('POST', `/missions/${fundC.mission.id}/status`, { status: 'completed' }, oeilB.token));
  await step('fundB validate', await api('POST', `/missions/${fundC.mission.id}/validate`, {}, client.token));
  const oeilBBalBefore = (await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeilB.id]))[0].balance;
  console.log('oeilB balance après financement:', oeilBBalBefore);

  const lateTime = new Date(TARGET_TICK.getTime() - 1.5 * 60 * 1000).toISOString(); // 1.5min de retard @19:30

  const cA = await step('A create', await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit fix2 repro A (balance=0)', address: '1 rue N', city: 'Casablanca',
    scheduled_at: lateTime, price: 150,
  }, client.token));
  await step('A interest', await api('POST', `/missions/${cA.mission.id}/interest`, {}, oeilA.token));
  await step('A hire', await api('POST', `/missions/${cA.mission.id}/hire/${oeilA.id}`, {}, client.token));

  const cB = await step('B create', await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit fix2 repro B (balance=140)', address: '1 rue O', city: 'Casablanca',
    scheduled_at: lateTime, price: 150,
  }, client.token));
  await step('B interest', await api('POST', `/missions/${cB.mission.id}/interest`, {}, oeilB.token));
  await step('B hire', await api('POST', `/missions/${cB.mission.id}/hire/${oeilB.id}`, {}, client.token));

  console.log('⏳ Attente tick 19:30 UTC...');
  const waitUntil = TARGET_TICK.getTime() + 90 * 1000;
  let doneA = false, doneB = false;
  while (Date.now() < waitUntil && !(doneA && doneB)) {
    await new Promise(r => setTimeout(r, 10000));
    if (!doneA) { const r = await db('SELECT status FROM missions WHERE id=$1', [cA.mission.id]); if (r[0].status === 'pending') doneA = true; }
    if (!doneB) { const r = await db('SELECT status FROM missions WHERE id=$1', [cB.mission.id]); if (r[0].status === 'pending') doneB = true; }
  }

  const walletA = await db(`SELECT * FROM wallet_transactions WHERE mission_id=$1`, [cA.mission.id]);
  const balA = (await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeilA.id]))[0].balance;
  const walletB = await db(`SELECT * FROM wallet_transactions WHERE mission_id=$1 AND user_id=$2`, [cB.mission.id, oeilB.id]);
  const balB = (await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeilB.id]))[0].balance;

  console.log(JSON.stringify({
    scenario: 'RE-TEST v2 après correction — pénalité H+30 plafonnée au solde réel',
    caseA_balance0: {
      balanceBefore: '0.00', balanceAfter: balA, wallet: walletA,
      ok: walletA.length === 1 && parseFloat(walletA[0].amount) === 0 && parseFloat(balA) === 0,
    },
    caseB_balance140: {
      balanceBefore: oeilBBalBefore, balanceAfter: balB,
      expected_balanceAfter: Math.round((parseFloat(oeilBBalBefore) - 100) * 100) / 100,
      wallet: walletB,
      ok: walletB.length === 1 && parseFloat(walletB[0].amount) === 100 && parseFloat(balB) === Math.round((parseFloat(oeilBBalBefore) - 100) * 100) / 100,
    },
  }, null, 2));

  await resetSetting('late_start_alert_window_minutes', admin.token);
  await resetSetting('late_start_auto_transfer_minutes', admin.token);
  await end();
})();
