// Scénario 12 — Abandon en cours de mission sans remplaçant : pénalité -100 MAD sur
// oeil_profiles.balance (pas users.balance) + cooldown réduit (abandon_during_mission_cooldown_hours).
const { db, api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');

async function step(label, r) {
  console.log(label, r.status, JSON.stringify(r.data));
  if (r.status >= 400) throw new Error(`${label} failed`);
  return r.data;
}

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;
  const oeil0 = accounts.oeils[0];

  // ── 1. Financer oeil0 via une mission complète normale (paiement réel) ──
  const c1 = await step('create funding mission', await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit abandon — funding mission', address: '1 rue Test', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + 3 * 3600 * 1000).toISOString(), price: 300,
  }, client.token));
  const fundMission = c1.mission;
  await step('interest', await api('POST', `/missions/${fundMission.id}/interest`, {}, oeil0.token));
  const hire1 = await step('hire', await api('POST', `/missions/${fundMission.id}/hire/${oeil0.id}`, {}, client.token));
  await step('en_route', await api('POST', `/missions/${fundMission.id}/status`, { status: 'en_route' }, oeil0.token));
  await step('active', await api('POST', `/missions/${fundMission.id}/status`, { status: 'active' }, oeil0.token));
  await step('completed', await api('POST', `/missions/${fundMission.id}/status`, { status: 'completed' }, oeil0.token));
  await step('validate', await api('POST', `/missions/${fundMission.id}/validate`, {}, client.token));

  const balBeforeAbandon = (await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil0.id]))[0].balance;
  console.log('oeil0 balance après financement:', balBeforeAbandon);

  // ── 2. Créer la mission cible de l'abandon, l'amener à 'active' ──
  const c2 = await step('create target mission', await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit abandon — target mission', address: '2 rue Test', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + 3 * 3600 * 1000).toISOString(), price: 220,
  }, client.token));
  const targetMission = c2.mission;
  await step('interest2', await api('POST', `/missions/${targetMission.id}/interest`, {}, oeil0.token));
  await step('hire2', await api('POST', `/missions/${targetMission.id}/hire/${oeil0.id}`, {}, client.token));
  await step('en_route2', await api('POST', `/missions/${targetMission.id}/status`, { status: 'en_route' }, oeil0.token));
  await step('active2', await api('POST', `/missions/${targetMission.id}/status`, { status: 'active' }, oeil0.token));

  // ── 3. Oeil signale empêchement en cours de mission → transfer_type='during' ──
  const transferRes = await step('transfer', await api('POST', `/missions/${targetMission.id}/transfer`, { reason: 'Audit — empêchement simulé' }, oeil0.token));
  console.log('transfer_deadline (avant forçage):', transferRes.deadline);

  // ── 4. Réduire abandon_during_mission_cooldown_hours (SEUL paramètre modifié) ──
  const testCooldownHours = 0.02; // ~72 secondes
  await setSetting('abandon_during_mission_cooldown_hours', String(testCooldownHours), admin.token);

  // ── 5. Forcer l'expiration immédiate du délai de grâce (SQL direct sur CETTE mission
  //      uniquement — n'affecte pas le setting transfer_grace_minutes, testé séparément) ──
  await db(`UPDATE missions SET transfer_deadline = NOW() - INTERVAL '5 seconds' WHERE id=$1`, [targetMission.id]);
  const clientBalBefore = (await db('SELECT balance FROM users WHERE id=$1', [client.id]))[0].balance;

  console.log('⏳ En attente du prochain tick cron checkTransferDeadlines (*/5 min)...');
  const cronRunAt = new Date();
  const deadline = Date.now() + 6 * 60 * 1000;
  let missionAfter;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10000));
    const rows = await db('SELECT status, cancel_reason FROM missions WHERE id=$1', [targetMission.id]);
    if (rows[0].status === 'cancelled') { missionAfter = rows[0]; break; }
  }

  if (!missionAfter) {
    console.error('❌ Le cron n\'a pas traité la mission dans le délai imparti');
  } else {
    const oeilBal = (await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil0.id]))[0].balance;
    const walletDebit = await db(`SELECT * FROM wallet_transactions WHERE user_id=$1 AND mission_id=$2 AND type='debit'`, [oeil0.id, targetMission.id]);
    const walletCreditClient = await db(`SELECT * FROM wallet_transactions WHERE user_id=$1 AND mission_id=$2 AND type='credit'`, [client.id, targetMission.id]);
    const clientBalAfter = (await db('SELECT balance FROM users WHERE id=$1', [client.id]))[0].balance;
    const reliab = await db(`SELECT points, reason, is_grave FROM reliability_events WHERE oeil_id=$1 AND mission_id=$2`, [oeil0.id, targetMission.id]);
    const userRow = (await db('SELECT transfer_cooldown_until, transfer_no_replacement_count FROM users WHERE id=$1', [oeil0.id]))[0];

    const expectedOeilBal = Math.round((parseFloat(balBeforeAbandon) - 100) * 100) / 100;
    const expectedClientDelta = 220; // 100% remboursement non imputable au client

    console.log(JSON.stringify({
      scenario: '12 abandon en cours de mission sans remplaçant',
      mission_status: missionAfter.status,
      cancel_reason: missionAfter.cancel_reason,
      oeil_balance_before: balBeforeAbandon,
      oeil_balance_after: oeilBal,
      expected_oeil_balance_after: expectedOeilBal,
      oeil_balance_ok: parseFloat(oeilBal) === expectedOeilBal,
      wallet_debit_oeil: walletDebit,
      wallet_debit_ok: walletDebit.length === 1 && parseFloat(walletDebit[0].amount) === 100 && walletDebit[0].reason.includes('remplaçant'),
      client_balance_before: clientBalBefore,
      client_balance_after: clientBalAfter,
      client_delta: Math.round((parseFloat(clientBalAfter) - parseFloat(clientBalBefore)) * 100) / 100,
      client_delta_ok: Math.round((parseFloat(clientBalAfter) - parseFloat(clientBalBefore)) * 100) / 100 === expectedClientDelta,
      wallet_credit_client: walletCreditClient,
      reliability_event: reliab,
      reliability_ok: reliab.length === 1 && reliab[0].points === -70 && reliab[0].is_grave === true,
      transfer_cooldown_until: userRow.transfer_cooldown_until,
      cron_run_approx_after: cronRunAt.toISOString(),
      cooldown_seconds_from_cron: (new Date(userRow.transfer_cooldown_until) - cronRunAt) / 1000,
      expected_cooldown_seconds_approx: testCooldownHours * 3600,
      transfer_no_replacement_count: userRow.transfer_no_replacement_count,
    }, null, 2));
  }

  // ── 6. Restaurer le paramètre modifié ──
  await resetSetting('abandon_during_mission_cooldown_hours', admin.token);
  await end();
})();
