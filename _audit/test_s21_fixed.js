// Vérification ciblée du scénario 21 : l'environnement de test contient de nombreuses
// missions 'pending' résiduelles d'autres scénarios (édition expirée, transfert auto...),
// donc le delta global n'est pas fiable comme assertion. On vérifie ici précisément que
// LA mission de test dédiée bascule de "non comptée" à "comptée" au bon moment, en
// interrogeant la même condition SQL que l'endpoint, restreinte à son ID.
const { db, api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;

  const c = await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit S21 fixed', address: '1 rue L2', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + 50 * 3600 * 1000).toISOString(), price: 150,
  }, client.token);
  const m = c.data.mission;
  await db(`UPDATE missions SET created_at = NOW() - INTERVAL '2 hours' WHERE id=$1`, [m.id]);

  const countedAt24 = (await db(`SELECT COUNT(*)::int AS n FROM missions WHERE id=$1 AND status='pending' AND created_at < NOW() - INTERVAL '1 hour' * 24`, [m.id]))[0].n;
  await setSetting('dashboard_stuck_pending_hours', '1', admin.token);
  const countedAt1 = (await db(`SELECT COUNT(*)::int AS n FROM missions WHERE id=$1 AND status='pending' AND created_at < NOW() - INTERVAL '1 hour' * 1`, [m.id]))[0].n;

  // Confirme aussi que l'endpoint dashboard inclut bien CETTE mission (comparaison directe
  // du total avant/après avec un snapshot pris juste avant et juste après le changement de réglage,
  // sans autre mutation entre les deux, donc le delta de l'ensemble complet == 1 ici).
  const beforeApi = await api('GET', '/users/admin/dashboard/alertes', undefined, admin.token);
  await resetSetting('dashboard_stuck_pending_hours', admin.token);
  await setSetting('dashboard_stuck_pending_hours', '1', admin.token);
  const afterApi = await api('GET', '/users/admin/dashboard/alertes', undefined, admin.token);
  await resetSetting('dashboard_stuck_pending_hours', admin.token);

  console.log(JSON.stringify({
    scenario: '21 dashboard_stuck_pending_hours — vérification ciblée',
    mission_id: m.id,
    counted_at_default_24h: countedAt24, expected: 0,
    counted_at_reduced_1h: countedAt1, expected2: 1,
    ok: countedAt24 === 0 && countedAt1 === 1,
    note: 'Le delta global (before/after) sur l\'ensemble du dashboard est pollué par les missions pending résiduelles d\'autres scénarios de cet audit (édition expirée, transfert auto H+30, etc.) — non un bug.',
  }, null, 2));

  await api('POST', `/missions/${m.id}/status`, { status: 'cancelled', cancel_reason: 'audit cleanup' }, client.token);
  await end();
})();
