// Scénario 6 — mission_edit_approval_minutes / _urgent / urgent_threshold_hours.
// Vérifie l'expiration auto (remise en pending) ET l'absence de TOUT mouvement financier.
const { db, api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;
  const oeilNormal = accounts.oeils[1];
  const oeilUrgent = accounts.oeils[2];

  await setSetting('mission_edit_approval_minutes', '1', admin.token);
  await setSetting('mission_edit_approval_minutes_urgent', '0.3', admin.token); // ~18s
  await setSetting('mission_edit_urgent_threshold_hours', '5', admin.token);

  async function setup(hoursAhead, oeil, title) {
    const c = await api('POST', '/missions', {
      type: 'personnalisee', title, address: '1 rue B', city: 'Casablanca',
      scheduled_at: new Date(Date.now() + hoursAhead * 3600 * 1000).toISOString(), price: 260,
    }, client.token);
    const m = c.data.mission;
    await api('POST', `/missions/${m.id}/interest`, {}, oeil.token);
    await api('POST', `/missions/${m.id}/hire/${oeil.id}`, {}, client.token);
    const walletBefore = await db(`SELECT COUNT(*)::int AS n FROM wallet_transactions WHERE mission_id=$1`, [m.id]);
    const edit = await api('PUT', `/missions/${m.id}`, { description: 'Nouvelle description — audit edit test' }, client.token);
    return { mission: m, editRes: edit.data, walletCountBefore: walletBefore[0].n };
  }

  const normal = await setup(10, oeilNormal, 'Audit edit NORMAL (hors urgence)');
  console.log('normal edit_request expires_at:', normal.editRes.edit_request.expires_at, ' created_at:', normal.editRes.edit_request.created_at);

  const urgent = await setup(3, oeilUrgent, 'Audit edit URGENT (dans le seuil)');
  console.log('urgent edit_request expires_at:', urgent.editRes.edit_request.expires_at, ' created_at:', urgent.editRes.edit_request.created_at);

  const normalDelayMin = (new Date(normal.editRes.edit_request.expires_at) - new Date(normal.editRes.edit_request.created_at)) / 60000;
  const urgentDelayMin = (new Date(urgent.editRes.edit_request.expires_at) - new Date(urgent.editRes.edit_request.created_at)) / 60000;
  console.log('normalDelayMin (attendu ~1):', normalDelayMin, ' urgentDelayMin (attendu ~0.3):', urgentDelayMin);

  console.log('⏳ Attente tick cron checkMissionEditRequestExpiry (*/5min), jusqu\'à 6min...');
  const deadline = Date.now() + 6 * 60 * 1000;
  let normalDone = false, urgentDone = false;
  while (Date.now() < deadline && !(normalDone && urgentDone)) {
    await new Promise(r => setTimeout(r, 10000));
    if (!normalDone) {
      const r = await db('SELECT status FROM mission_edit_requests WHERE id=$1', [normal.editRes.edit_request.id]);
      if (r[0].status === 'expired') normalDone = true;
    }
    if (!urgentDone) {
      const r = await db('SELECT status FROM mission_edit_requests WHERE id=$1', [urgent.editRes.edit_request.id]);
      if (r[0].status === 'expired') urgentDone = true;
    }
  }

  const normalMission = (await db('SELECT status, oeil_id, is_priority FROM missions WHERE id=$1', [normal.mission.id]))[0];
  const urgentMission = (await db('SELECT status, oeil_id, is_priority FROM missions WHERE id=$1', [urgent.mission.id]))[0];
  const normalWalletAfter = (await db(`SELECT COUNT(*)::int AS n FROM wallet_transactions WHERE mission_id=$1`, [normal.mission.id]))[0].n;
  const urgentWalletAfter = (await db(`SELECT COUNT(*)::int AS n FROM wallet_transactions WHERE mission_id=$1`, [urgent.mission.id]))[0].n;

  console.log(JSON.stringify({
    scenario: '6 mission_edit_approval_minutes(+urgent+threshold)',
    normal: {
      delayMinObserved: normalDelayMin, expected: 1,
      mission_status_after: normalMission.status, oeil_id_after: normalMission.oeil_id, is_priority: normalMission.is_priority,
      reset_ok: normalMission.status === 'pending' && normalMission.oeil_id === null && normalMission.is_priority === true,
      wallet_count_before: normal.walletCountBefore, wallet_count_after: normalWalletAfter,
      no_financial_movement_ok: normal.walletCountBefore === normalWalletAfter && normalWalletAfter === 0,
    },
    urgent: {
      delayMinObserved: urgentDelayMin, expected: 0.3,
      mission_status_after: urgentMission.status, oeil_id_after: urgentMission.oeil_id, is_priority: urgentMission.is_priority,
      reset_ok: urgentMission.status === 'pending' && urgentMission.oeil_id === null && urgentMission.is_priority === true,
      wallet_count_before: urgent.walletCountBefore, wallet_count_after: urgentWalletAfter,
      no_financial_movement_ok: urgent.walletCountBefore === urgentWalletAfter && urgentWalletAfter === 0,
    },
  }, null, 2));

  await resetSetting('mission_edit_approval_minutes', admin.token);
  await resetSetting('mission_edit_approval_minutes_urgent', admin.token);
  await resetSetting('mission_edit_urgent_threshold_hours', admin.token);
  await end();
})();
