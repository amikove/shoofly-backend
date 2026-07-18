// Scénario 5 — candidate_window_minutes_choose_queue / _other : sélection auto en mode "choose".
const { db, api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');
const extra = require('./extra_oeils.json');
const [, , oeilHigh, oeilLow] = extra; // oeil5 (95), oeil6 (60) — réutilisés pour les 2 missions (espacées de 6h pour éviter tout conflit de créneau)

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;

  await setSetting('candidate_window_minutes_choose_queue', '0.5', admin.token);
  await setSetting('candidate_window_minutes_choose_other', '0.5', admin.token);

  // ── QUEUE type, choose ──
  const cQ = await api('POST', '/missions', {
    type: 'file_attente', title: 'Audit candidate choose QUEUE', address: '1 rue A', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + 16 * 3600 * 1000).toISOString(), price: 200, replacement_preference: 'choose',
  }, client.token);
  const mQ = cQ.data.mission;
  await api('POST', `/missions/${mQ.id}/interest`, {}, accounts.oeils[1].token);
  await api('POST', `/missions/${mQ.id}/hire/${accounts.oeils[1].id}`, {}, client.token);
  const tQ = await api('POST', `/missions/${mQ.id}/transfer`, { reason: 'audit choose queue test' }, accounts.oeils[1].token);
  console.log('transfer queue ->', tQ.status, JSON.stringify(tQ.data));
  const iHQ = await api('POST', `/missions/${mQ.id}/interest`, {}, oeilHigh.token);
  const iLQ = await api('POST', `/missions/${mQ.id}/interest`, {}, oeilLow.token);
  console.log('interest queue high/low', iHQ.status, iLQ.status);

  // ── OTHER type (personnalisee), choose — espacée de 6h pour éviter conflit créneau avec oeilHigh/oeilLow ──
  const cO = await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit candidate choose OTHER', address: '2 rue A', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + 22 * 3600 * 1000).toISOString(), price: 200, replacement_preference: 'choose',
  }, client.token);
  const mO = cO.data.mission;
  await api('POST', `/missions/${mO.id}/interest`, {}, accounts.oeils[2].token);
  await api('POST', `/missions/${mO.id}/hire/${accounts.oeils[2].id}`, {}, client.token);
  const tO = await api('POST', `/missions/${mO.id}/transfer`, { reason: 'audit choose other test' }, accounts.oeils[2].token);
  console.log('transfer other ->', tO.status, JSON.stringify(tO.data));
  const iHO = await api('POST', `/missions/${mO.id}/interest`, {}, oeilHigh.token);
  const iLO = await api('POST', `/missions/${mO.id}/interest`, {}, oeilLow.token);
  console.log('interest other high/low', iHO.status, iLO.status);

  console.log('⏳ Attente tick cron sélection candidat (*/2min), jusqu\'à 4min...');
  const deadline = Date.now() + 4 * 60 * 1000;
  let assignedQ = null, assignedO = null;
  while (Date.now() < deadline && !(assignedQ && assignedO)) {
    await new Promise(r => setTimeout(r, 10000));
    if (!assignedQ) {
      const rq = await db('SELECT status, oeil_id FROM missions WHERE id=$1', [mQ.id]);
      if (rq[0].status === 'assigned' && rq[0].oeil_id) assignedQ = rq[0];
    }
    if (!assignedO) {
      const ro = await db('SELECT status, oeil_id FROM missions WHERE id=$1', [mO.id]);
      if (ro[0].status === 'assigned' && ro[0].oeil_id) assignedO = ro[0];
    }
  }

  console.log(JSON.stringify({
    scenario: '5 candidate_window_minutes_choose_queue/_other',
    queue: { assigned_oeil_id: assignedQ?.oeil_id, expected: oeilHigh.id, ok: assignedQ?.oeil_id === oeilHigh.id },
    other: { assigned_oeil_id: assignedO?.oeil_id, expected: oeilHigh.id, ok: assignedO?.oeil_id === oeilHigh.id },
  }, null, 2));

  await resetSetting('candidate_window_minutes_choose_queue', admin.token);
  await resetSetting('candidate_window_minutes_choose_other', admin.token);
  await end();
})();
