// Prépare les données pour les scénarios 7, 13, 14, 15, 16, 19 qui dépendent tous du
// tick cron */30min ou horaire (tous alignés à :00). Batch groupé délibérément pour
// éviter d'attendre séparément jusqu'à 60min par scénario — voir note dans le rapport
// final sur la justification de cette dérogation à la règle "un seul paramètre à la fois"
// (aucun de ces tests, sauf le 7 et le volet financier du 15, ne touche à l'argent, et
// chaque effet reste attribuable sans ambiguïté via mission_id / user_id distincts).
const { db, api, setSetting, end } = require('./lib');
const accounts = require('./accounts.json');
const oeil7 = require('./oeil7.json');

async function step(label, r) {
  console.log(label, r.status, JSON.stringify(r.data && r.data.mission ? { id: r.data.mission.id, status: r.data.mission.status } : r.data));
  if (r.status >= 400) throw new Error(`${label} failed: ${JSON.stringify(r.data)}`);
  return r.data;
}

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;
  const oeil0 = accounts.oeils[0]; // financé (balance 140 après scénario 12) -> pour le volet financier du 15
  const oeilFund = accounts.oeils[1];

  // ── Réglages (tous modifiés ensemble pour ce batch) ──
  await setSetting('client_validation_hours', '0.02', admin.token); // ~72s
  await setSetting('stale_mission_hours', '0.01', admin.token); // ~36s
  await setSetting('stale_mission_min_lead_hours', '0.01', admin.token);
  await setSetting('mission_overdue_verification_hours', '0.01', admin.token); // ~36s
  await setSetting('late_start_alert_window_minutes', '1', admin.token);
  await setSetting('late_start_auto_transfer_minutes', '2', admin.token);
  await setSetting('reminder_before_mission_minutes_early', '3', admin.token);
  await setSetting('reminder_before_mission_minutes_late', '1', admin.token);
  await setSetting('ticket_auto_resolve_hours', '0.02', admin.token); // ~72s

  const out = {};

  // ── Scénario 7 : client_validation_hours ──
  const c7 = await step('S7 create', await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit S7 client_validation', address: '1 rue C', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + 5 * 3600 * 1000).toISOString(), price: 240,
  }, client.token));
  const m7 = c7.mission;
  await step('S7 interest', await api('POST', `/missions/${m7.id}/interest`, {}, oeilFund.token));
  await step('S7 hire', await api('POST', `/missions/${m7.id}/hire/${oeilFund.id}`, {}, client.token));
  await step('S7 en_route', await api('POST', `/missions/${m7.id}/status`, { status: 'en_route' }, oeilFund.token));
  await step('S7 active', await api('POST', `/missions/${m7.id}/status`, { status: 'active' }, oeilFund.token));
  await step('S7 completed', await api('POST', `/missions/${m7.id}/status`, { status: 'completed' }, oeilFund.token));
  const oeilFundBalBefore = (await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeilFund.id]))[0].balance;
  out.s7 = { missionId: m7.id, oeil_earning: m7.oeil_earning, oeilId: oeilFund.id, balanceBefore: oeilFundBalBefore };

  // ── Scénario 13 : stale_mission_hours / min_lead ──
  const c13 = await step('S13 create', await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit S13 stale mission', address: '1 rue D', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + 10 * 3600 * 1000).toISOString(), price: 150,
  }, client.token));
  out.s13 = { missionId: c13.mission.id };

  // ── Scénario 14 : mission_overdue_verification_hours ──
  const c14 = await step('S14 create', await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit S14 overdue verification', address: '1 rue E', city: 'Casablanca',
    scheduled_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(), price: 150,
  }, client.token));
  const m14 = c14.mission;
  await step('S14 interest', await api('POST', `/missions/${m14.id}/interest`, {}, oeil7.token));
  await step('S14 hire', await api('POST', `/missions/${m14.id}/hire/${oeil7.id}`, {}, client.token));
  await step('S14 en_route', await api('POST', `/missions/${m14.id}/status`, { status: 'en_route' }, oeil7.token));
  await step('S14 active', await api('POST', `/missions/${m14.id}/status`, { status: 'active' }, oeil7.token));
  out.s14 = { missionId: m14.id };

  // ── Scénario 15 : late_start — L1 alerte seule (H, 0-1min de retard @18:00), L2 auto-transfert (H+30 equiv, 1-2min @18:00) ──
  const target = new Date('2026-07-17T18:00:00.000Z');
  const l1Time = new Date(target.getTime() - 0.5 * 60 * 1000); // 30s de retard à 18:00
  const l2Time = new Date(target.getTime() - 1.5 * 60 * 1000); // 1.5min de retard à 18:00

  const cL1 = await step('S15 L1 create', await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit S15 L1 alert-only', address: '1 rue F', city: 'Casablanca',
    scheduled_at: l1Time.toISOString(), price: 150,
  }, client.token));
  // besoin d'un oeil dispo sans conflit -> utiliser un oeil frais dédié L1 (créé à la volée)
  const regL1 = await api('POST', '/auth/register', { email: `audit2_oeilL1_${Date.now()}@test.local`, password: 'Test1234!', first_name: 'AuditL1', last_name: 'Test', role: 'oeil', city: 'Casablanca' });
  const oeilL1 = { token: regL1.data.token, id: regL1.data.user.id };
  await db(`UPDATE oeil_profiles SET is_verified=true, is_available=true WHERE user_id=$1`, [oeilL1.id]);
  await step('S15 L1 interest', await api('POST', `/missions/${cL1.mission.id}/interest`, {}, oeilL1.token));
  await step('S15 L1 hire', await api('POST', `/missions/${cL1.mission.id}/hire/${oeilL1.id}`, {}, client.token));
  out.s15L1 = { missionId: cL1.mission.id, oeilId: oeilL1.id };

  const cL2 = await step('S15 L2 create', await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit S15 L2 auto-transfer', address: '1 rue G', city: 'Casablanca',
    scheduled_at: l2Time.toISOString(), price: 260,
  }, client.token));
  await step('S15 L2 interest', await api('POST', `/missions/${cL2.mission.id}/interest`, {}, oeil0.token));
  await step('S15 L2 hire', await api('POST', `/missions/${cL2.mission.id}/hire/${oeil0.id}`, {}, client.token));
  const oeil0BalBefore = (await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil0.id]))[0].balance;
  const clientBalBeforeL2 = (await db('SELECT balance FROM users WHERE id=$1', [client.id]))[0].balance;
  out.s15L2 = { missionId: cL2.mission.id, oeilId: oeil0.id, oeil0BalBefore, clientBalBeforeL2, price: 260 };

  // ── Scénario 16 : reminders early/late (bande fixe ±10min autour du cron) ──
  const cR = await step('S16 create', await api('POST', '/missions', {
    type: 'personnalisee', title: 'Audit S16 reminders', address: '1 rue H', city: 'Casablanca',
    scheduled_at: new Date(target.getTime() + 5 * 60 * 1000).toISOString(), price: 150,
  }, client.token));
  const regR = await api('POST', '/auth/register', { email: `audit2_oeilR_${Date.now()}@test.local`, password: 'Test1234!', first_name: 'AuditR', last_name: 'Test', role: 'oeil', city: 'Casablanca' });
  const oeilR = { token: regR.data.token, id: regR.data.user.id };
  await db(`UPDATE oeil_profiles SET is_verified=true, is_available=true WHERE user_id=$1`, [oeilR.id]);
  await step('S16 interest', await api('POST', `/missions/${cR.mission.id}/interest`, {}, oeilR.token));
  await step('S16 hire', await api('POST', `/missions/${cR.mission.id}/hire/${oeilR.id}`, {}, client.token));
  out.s16 = { missionId: cR.mission.id, oeilId: oeilR.id };

  // ── Scénario 19 : ticket_auto_resolve_hours (+ exclusion is_urgent) ──
  const tNormal = await step('S19 ticket normal', await api('POST', '/tickets', { category: 'compte', initial_message: 'Audit S19 — question compte' }, client.token));
  await step('S19 admin reply normal', await api('POST', `/tickets/${tNormal.ticket.id}/messages`, { content: 'Réponse admin — audit test' }, admin.token));
  const tUrgent = await step('S19 ticket urgent', await api('POST', '/tickets', { category: 'urgence', initial_message: 'Audit S19 — urgence test' }, client.token));
  await step('S19 admin reply urgent', await api('POST', `/tickets/${tUrgent.ticket.id}/messages`, { content: 'Réponse admin — audit test urgent' }, admin.token));
  out.s19 = { normalTicketId: tNormal.ticket.id, urgentTicketId: tUrgent.ticket.id };

  require('fs').writeFileSync(require('path').join(__dirname, 'batch_hourly_refs.json'), JSON.stringify(out, null, 2));
  console.log('SETUP TERMINÉ ->', JSON.stringify(out, null, 2));
  await end();
})();
