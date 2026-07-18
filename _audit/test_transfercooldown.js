// Scénario 2 — transfer_cooldown_hours : déblocage après expiration.
const { db, api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;
  const oeil = accounts.oeils[1];
  const results = [];

  // Réduire le cooldown AVANT de déclencher un transfert 'during' (la durée du cooldown
  // appliqué dépend du setting au moment où le transfert a lieu).
  const testHours = 0.02; // ~72s
  await setSetting('transfer_cooldown_hours', String(testHours), admin.token);

  // Créer + assigner + démarrer une mission, puis transférer "during" pour déclencher le cooldown
  const c = await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit cooldown source mission', address: '1 rue A', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString(), price: 150,
  }, client.token);
  const m1 = c.data.mission;
  await api('POST', `/missions/${m1.id}/interest`, {}, oeil.token);
  await api('POST', `/missions/${m1.id}/hire/${oeil.id}`, {}, client.token);
  await api('POST', `/missions/${m1.id}/status`, { status: 'en_route' }, oeil.token);
  await api('POST', `/missions/${m1.id}/status`, { status: 'active' }, oeil.token);
  const transferRes = await api('POST', `/missions/${m1.id}/transfer`, { reason: 'audit cooldown test' }, oeil.token);
  console.log('transfer during ->', transferRes.status, JSON.stringify(transferRes.data));

  const cooldownRow = (await db('SELECT transfer_cooldown_until FROM users WHERE id=$1', [oeil.id]))[0];
  console.log('cooldown_until:', cooldownRow.transfer_cooldown_until, ' (attendu ~', new Date(Date.now() + testHours * 3600 * 1000).toISOString(), ')');

  // Créer une 2e mission pour tester si l'oeil peut postuler pendant le cooldown
  const c2 = await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit cooldown blocked-attempt', address: '2 rue A', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + 20 * 3600 * 1000).toISOString(), price: 150,
  }, client.token);
  const m2 = c2.data.mission;

  const rBlocked = await api('POST', `/missions/${m2.id}/interest`, {}, oeil.token);
  results.push({ test: 'pendant cooldown -> doit bloquer', status: rBlocked.status, ok: rBlocked.status === 403 });

  console.log('⏳ Attente expiration cooldown (~80s)...');
  await new Promise(r => setTimeout(r, 80 * 1000));

  const rUnblocked = await api('POST', `/missions/${m2.id}/interest`, {}, oeil.token);
  results.push({ test: 'apres expiration -> doit debloquer', status: rUnblocked.status, ok: rUnblocked.status === 201 });

  await resetSetting('transfer_cooldown_hours', admin.token);

  // Nettoyage
  await api('POST', `/missions/${m2.id}/status`, { status: 'cancelled', cancel_reason: 'audit cleanup' }, client.token);
  // m1 est en 'pending' suite au transfer during -> on la laisse pour test A3 (grace) ou on l'annule:
  await api('POST', `/missions/${m1.id}/status`, { status: 'cancelled', cancel_reason: 'audit cleanup' }, client.token);

  console.log(JSON.stringify(results, null, 2));
  await end();
})();
