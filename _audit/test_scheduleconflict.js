// Scénario 1 — schedule_conflict_window_hours : blocage/déblocage dans les 2 sens.
const { db, api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');

async function step(label, r) {
  console.log(label, r.status, JSON.stringify(r.data));
  return r;
}

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;
  const oeil = accounts.oeils[1]; // dédié Groupe A

  const baseTime = Date.now() + 10 * 3600 * 1000; // +10h, loin de toute autre mission

  async function createMission(offsetHours, title) {
    const r = await api('POST', '/missions', {
      type: 'personnalisee', title, address: '1 rue A', city: 'Casablanca',
      scheduled_at: new Date(baseTime + offsetHours * 3600 * 1000).toISOString(), price: 150,
    }, client.token);
    return r.data.mission;
  }

  const results = [];

  // Mission ancre : assignée à l'oeil, à baseTime+0h
  const anchor = await createMission(0, 'Audit conflict anchor');
  await step('interest anchor', await api('POST', `/missions/${anchor.id}/interest`, {}, oeil.token));
  await step('hire anchor', await api('POST', `/missions/${anchor.id}/hire/${oeil.id}`, {}, client.token));

  // ── Test 1 : à 1h d'écart, fenêtre par défaut (4h) → DOIT être bloqué ──
  const m1h = await createMission(1, 'Audit conflict +1h (default window)');
  const r1 = await step('interest +1h @default(4h)', await api('POST', `/missions/${m1h.id}/interest`, {}, oeil.token));
  results.push({ test: 'defaut 4h, ecart 1h -> doit bloquer', status: r1.status, blocked: r1.status === 400, ok: r1.status === 400 });

  // ── Réduire la fenêtre à 0.5h ──
  await setSetting('schedule_conflict_window_hours', '0.5', admin.token);

  // ── Test 2 : même écart 1h, fenêtre réduite 0.5h → DOIT être débloqué ──
  const r2 = await step('interest +1h @reduced(0.5h)', await api('POST', `/missions/${m1h.id}/interest`, {}, oeil.token));
  results.push({ test: 'reduit 0.5h, ecart 1h -> doit debloquer', status: r2.status, ok: r2.status === 201 });

  // ── Test 3 : écart 0.2h (12min), fenêtre réduite 0.5h → DOIT rester bloqué ──
  const mClose = await createMission(0.2, 'Audit conflict +0.2h (reduced window)');
  const r3 = await step('interest +0.2h @reduced(0.5h)', await api('POST', `/missions/${mClose.id}/interest`, {}, oeil.token));
  results.push({ test: 'reduit 0.5h, ecart 0.2h -> doit rester bloque', status: r3.status, ok: r3.status === 400 });

  await resetSetting('schedule_conflict_window_hours', admin.token);

  // Nettoyage : annuler les missions créées
  for (const m of [anchor, m1h, mClose]) {
    await api('POST', `/missions/${m.id}/status`, { status: 'cancelled', cancel_reason: 'audit cleanup' }, client.token);
  }

  console.log(JSON.stringify(results, null, 2));
  await end();
})();
