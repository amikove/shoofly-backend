// Correction méthodologique du scénario 20 : le calcul doit être déclenché via l'API HTTP
// (GET /:id/interests) pour utiliser le cache settings du VRAI process serveur — un script
// autonome qui require() directement responseTime.js a son propre cache local périmé,
// ce qui avait faussé le premier essai (faux négatif de test, pas un bug applicatif).
const { api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;

  const login = await api('POST', '/auth/login', { email: 'audit2_oeilrt_1784314699167@test.local', password: 'Test1234!' });
  const oeil = { token: login.data.token, id: login.data.user.id };

  // Nouvelle mission pending pour que cet oeil apparaisse comme candidat via /interests
  const c = await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit S20 second mission (candidat)', address: '1 rue K', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + 40 * 3600 * 1000).toISOString(), price: 150,
  }, client.token);
  const m2 = c.data.mission;
  await api('POST', `/missions/${m2.id}/interest`, {}, oeil.token);

  const beforeRes = await api('GET', `/missions/${m2.id}/interests`, undefined, client.token);
  const beforeCandidate = beforeRes.data.interests.find(i => i.id === oeil.id);

  await setSetting('response_time_min_turns', '1', admin.token);
  const afterRes = await api('GET', `/missions/${m2.id}/interests`, undefined, client.token);
  const afterCandidate = afterRes.data.interests.find(i => i.id === oeil.id);
  await resetSetting('response_time_min_turns', admin.token);

  console.log(JSON.stringify({
    scenario: '20 response_time_min_turns (via HTTP, cache serveur réel)',
    beforeVal: beforeCandidate?.avg_response_minutes,
    afterVal: afterCandidate?.avg_response_minutes,
    ok: beforeCandidate?.avg_response_minutes === null && typeof afterCandidate?.avg_response_minutes === 'number',
  }, null, 2));

  await end();
})();
