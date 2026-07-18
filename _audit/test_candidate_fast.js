// Scénario 4 — candidate_window_minutes_fast : sélection auto du meilleur candidat (reliability_score).
const { db, api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');
const extra = require('./extra_oeils.json');
const [oeilHigh, oeilLow] = extra; // reliability_score 95 vs 60

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;
  const oeilInit = accounts.oeils[0]; // celui qui va se désister

  await setSetting('candidate_window_minutes_fast', '0.5', admin.token); // 30s

  const c = await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit candidate fast', address: '1 rue A', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + 15 * 3600 * 1000).toISOString(), price: 200,
  }, client.token);
  const m = c.data.mission;
  await api('POST', `/missions/${m.id}/interest`, {}, oeilInit.token);
  await api('POST', `/missions/${m.id}/hire/${oeilInit.id}`, {}, client.token);

  // Œil initial signale empêchement (before) -> mission repasse pending, replacement_preference='fast' par défaut
  const t = await api('POST', `/missions/${m.id}/transfer`, { reason: 'audit candidate fast test' }, oeilInit.token);
  console.log('transfer ->', t.status, JSON.stringify(t.data));

  // 2 candidats avec reliability_score différent postulent
  const iHigh = await api('POST', `/missions/${m.id}/interest`, {}, oeilHigh.token);
  const iLow = await api('POST', `/missions/${m.id}/interest`, {}, oeilLow.token);
  console.log('interest high', iHigh.status, 'interest low', iLow.status);

  console.log('⏳ Attente tick cron sélection candidat (*/2min), jusqu\'à 4min...');
  const deadline = Date.now() + 4 * 60 * 1000;
  let assigned = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10000));
    const rows = await db('SELECT status, oeil_id FROM missions WHERE id=$1', [m.id]);
    if (rows[0].status === 'assigned' && rows[0].oeil_id) { assigned = rows[0]; break; }
  }

  const result = {
    scenario: '4 candidate_window_minutes_fast — sélection meilleur candidat',
    assigned_oeil_id: assigned?.oeil_id,
    expected_oeil_id: oeilHigh.id,
    ok: assigned?.oeil_id === oeilHigh.id,
  };
  console.log(JSON.stringify(result, null, 2));

  await resetSetting('candidate_window_minutes_fast', admin.token);
  await end();
})();
