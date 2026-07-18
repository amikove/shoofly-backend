// Scénarios 21 (dashboard_stuck_pending_hours) et 22 (dashboard_low_reliability_threshold).
const { db, api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;
  const results = {};

  // ═══ Scénario 21 — dashboard_stuck_pending_hours ═══
  {
    const c = await api('POST', '/missions', {
      type: 'personnalisee', title: 'Audit S21 stuck pending', address: '1 rue L', city: 'Casablanca',
      scheduled_at: new Date(Date.now() + 50 * 3600 * 1000).toISOString(), price: 150,
    }, client.token);
    const m = c.data.mission;
    // Backdate created_at à 2h dans le passé (simule une mission bloquée depuis 2h)
    await db(`UPDATE missions SET created_at = NOW() - INTERVAL '2 hours' WHERE id=$1`, [m.id]);

    const before = await api('GET', '/users/admin/dashboard/alertes', undefined, admin.token);
    const countBefore = before.data.instant.missions_stuck_pending;

    await setSetting('dashboard_stuck_pending_hours', '1', admin.token);
    const after = await api('GET', '/users/admin/dashboard/alertes', undefined, admin.token);
    const countAfter = after.data.instant.missions_stuck_pending;
    await resetSetting('dashboard_stuck_pending_hours', admin.token);

    results.s21 = {
      countBefore_24h_default: countBefore, countAfter_1h_reduced: countAfter,
      delta: countAfter - countBefore,
      ok: countAfter === countBefore + 1,
    };

    // Nettoyage
    await api('POST', `/missions/${m.id}/status`, { status: 'cancelled', cancel_reason: 'audit cleanup' }, client.token);
  }

  // ═══ Scénario 22 — dashboard_low_reliability_threshold ═══
  {
    const reg = await api('POST', '/auth/register', { email: `audit2_oeilLowRel_${Date.now()}@test.local`, password: 'Test1234!', first_name: 'AuditLowRel', last_name: 'Test', role: 'oeil', city: 'Casablanca' });
    const oeil = { id: reg.data.user.id };
    await db(`UPDATE users SET reliability_score=75 WHERE id=$1`, [oeil.id]); // entre 70 (défaut) et 90

    const before = await api('GET', '/users/admin/dashboard/alertes', undefined, admin.token);
    const countBefore = before.data.instant.low_reliability_oeils;

    await setSetting('dashboard_low_reliability_threshold', '90', admin.token);
    const after = await api('GET', '/users/admin/dashboard/alertes', undefined, admin.token);
    const countAfter = after.data.instant.low_reliability_oeils;
    await resetSetting('dashboard_low_reliability_threshold', admin.token);

    results.s22 = {
      countBefore_70_default: countBefore, countAfter_90_reduced: countAfter,
      delta: countAfter - countBefore,
      ok: countAfter === countBefore + 1,
    };
  }

  console.log(JSON.stringify(results, null, 2));
  await end();
})();
