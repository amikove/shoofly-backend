// Scénario 3 — transfer_grace_minutes_queue / _other : annulation auto rapide sans remplaçant.
const { db, api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;
  const oeilQueue = accounts.oeils[1];
  const oeilOther = accounts.oeils[2];

  await setSetting('transfer_grace_minutes_queue', '1', admin.token);
  await setSetting('transfer_grace_minutes_other', '1', admin.token);

  async function setupTransferBefore(type, oeil, title) {
    const c = await api('POST', '/missions', {
      type, title, address: '1 rue A', city: 'Casablanca',
      scheduled_at: new Date(Date.now() + 12 * 3600 * 1000).toISOString(), price: 180,
    }, client.token);
    const m = c.data.mission;
    await api('POST', `/missions/${m.id}/interest`, {}, oeil.token);
    await api('POST', `/missions/${m.id}/hire/${oeil.id}`, {}, client.token);
    const t = await api('POST', `/missions/${m.id}/transfer`, { reason: 'audit grace test' }, oeil.token);
    return { mission: m, transferRes: t.data };
  }

  const clientBalBefore = (await db('SELECT balance FROM users WHERE id=$1', [client.id]))[0].balance;

  const queueSetup = await setupTransferBefore('file_attente', oeilQueue, 'Audit grace QUEUE');
  const otherSetup = await setupTransferBefore('personnalisee', oeilOther, 'Audit grace OTHER');
  console.log('queue deadline:', queueSetup.transferRes.deadline, ' other deadline:', otherSetup.transferRes.deadline);

  console.log('⏳ Attente tick cron checkTransferDeadlines (jusqu\'à 7min)...');
  const deadline = Date.now() + 7 * 60 * 1000;
  let queueDone = false, otherDone = false;
  while (Date.now() < deadline && !(queueDone && otherDone)) {
    await new Promise(r => setTimeout(r, 10000));
    const rq = await db('SELECT status,cancel_reason FROM missions WHERE id=$1', [queueSetup.mission.id]);
    const ro = await db('SELECT status,cancel_reason FROM missions WHERE id=$1', [otherSetup.mission.id]);
    queueDone = rq[0].status === 'cancelled';
    otherDone = ro[0].status === 'cancelled';
  }

  const clientBalAfter = (await db('SELECT balance FROM users WHERE id=$1', [client.id]))[0].balance;
  const walletQueue = await db(`SELECT * FROM wallet_transactions WHERE mission_id=$1`, [queueSetup.mission.id]);
  const walletOther = await db(`SELECT * FROM wallet_transactions WHERE mission_id=$1`, [otherSetup.mission.id]);
  const mq = (await db('SELECT status,cancel_reason FROM missions WHERE id=$1', [queueSetup.mission.id]))[0];
  const mo = (await db('SELECT status,cancel_reason FROM missions WHERE id=$1', [otherSetup.mission.id]))[0];

  console.log(JSON.stringify({
    queue: { status: mq.status, cancel_reason: mq.cancel_reason, wallet: walletQueue, refund_ok: walletQueue.length === 1 && parseFloat(walletQueue[0].amount) === 180 },
    other: { status: mo.status, cancel_reason: mo.cancel_reason, wallet: walletOther, refund_ok: walletOther.length === 1 && parseFloat(walletOther[0].amount) === 180 },
    clientBalBefore, clientBalAfter, totalDelta: Math.round((parseFloat(clientBalAfter) - parseFloat(clientBalBefore)) * 100) / 100,
  }, null, 2));

  await resetSetting('transfer_grace_minutes_queue', admin.token);
  await resetSetting('transfer_grace_minutes_other', admin.token);
  await end();
})();
