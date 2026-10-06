// Tests des notifications modifiées (audit notifications, 2026-10-06) — base réelle (DATABASE_URL).
// Données : préfixe unique TSTN_<run>, nettoyage ciblé en fin de run. Réglages modifiés le temps
// du test puis restaurés. Sans DATABASE_URL, la suite est sautée (skip) et le signale.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const ROOT = path.join(__dirname, '..');
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return null;
  const m = fs.readFileSync(envFile, 'utf8').match(/^DATABASE_URL=(.*)$/m);
  return m ? m[1].trim() : null;
}
const URL_DB = databaseUrl();
const SKIP = URL_DB ? false : 'DATABASE_URL absente — tests base sautés';

// Aucun appel réseau WhatsApp pendant les tests : services/wasel.js ignore l'envoi sans clé. Clé
// VIDE (et non supprimée) : dotenv ne remplace pas une variable déjà définie, même vide.
process.env.WASEL_API_KEY = '';
// Aucun push web pendant les tests : sans clés VAPID, services/push.js reste inerte.
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';

const RUN = 'TSTN_' + Date.now().toString(36);
let db;
const saved = {};
const SETTINGS = {
  stale_mission_hours: '7',          // valeur NON par défaut (défaut 12) — le texte doit suivre
  stale_mission_min_lead_hours: '4',
  quiet_hours_start: '3',            // début = fin → plage désactivée pendant les tests
  quiet_hours_end: '3',
};
const ids = { clients: [], oeils: [], missions: [] };

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}
async function getRawSetting(key) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
  return rows.length ? rows[0].value : null;
}
async function makeUser(role, { verified = true, available = true, city = 'Rabat' } = {}) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users (id,email,password,role,first_name,last_name,phone,city)
     VALUES ($1,$2,'x',$3,'Test','Notif',NULL,$4)`,
    [id, `${RUN}_${id}@test.invalid`, role, city]);
  if (role === 'oeil') {
    await db.query(
      `INSERT INTO oeil_profiles (user_id, is_verified, is_available, rating_avg, rating_count, total_missions)
       VALUES ($1,$2,$3,4.5,1,1)`, [id, verified, available]);
  }
  return id;
}
async function makeMission(clientId, { hoursOld = 8, hoursAhead = 10, title = 'Mission test' } = {}) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO missions (id, client_id, type, status, title, address, city, scheduled_at,
                           price, commission, oeil_earning, created_at)
     VALUES ($1,$2,'immobilier','pending',$3,'Adresse test','Rabat',
             NOW() + INTERVAL '1 hour' * $4::numeric, 200, 20, 180,
             NOW() - INTERVAL '1 hour' * $5::numeric)`,
    [id, clientId, `${RUN} ${title}`, hoursAhead, hoursOld]);
  ids.missions.push(id);
  return id;
}
async function interest(missionId, oeilId, { declined = false } = {}) {
  await db.query(
    `INSERT INTO mission_interests (mission_id, oeil_id, declined, created_at)
     VALUES ($1,$2,$3, NOW() - INTERVAL '2 hours')`, [missionId, oeilId, declined]);
}

before(async () => {
  if (SKIP) return;
  const { Pool } = require('pg');
  db = new Pool({ connectionString: URL_DB, max: 3 });
  for (const k of Object.keys(SETTINGS)) saved[k] = await getRawSetting(k);
  for (const [k, v] of Object.entries(SETTINGS)) await setSetting(k, v);
  const client = await makeUser('client');
  ids.clients.push(client);
  for (let i = 0; i < 3; i++) ids.oeils.push(await makeUser('oeil'));
});

after(async () => {
  if (SKIP || !db) return;
  const missionIds = ids.missions;
  if (missionIds.length) {
    await db.query('DELETE FROM notifications WHERE mission_id = ANY($1::text[])', [missionIds]);
    await db.query('DELETE FROM mission_interests WHERE mission_id = ANY($1::text[])', [missionIds]);
    await db.query('DELETE FROM missions WHERE id = ANY($1::text[])', [missionIds]);
  }
  await db.query(`DELETE FROM deferred_notifications WHERE payload->>'title' LIKE $1`, [`${RUN}%`]);
  const users = [...ids.clients, ...ids.oeils];
  if (users.length) {
    await db.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [users]);
    await db.query('DELETE FROM oeil_profiles WHERE user_id = ANY($1::text[])', [ids.oeils]);
    await db.query('DELETE FROM oeil_availability WHERE user_id = ANY($1::text[])', [ids.oeils]);
    await db.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  }
  for (const [k, v] of Object.entries(saved)) {
    if (v === null) await db.query('DELETE FROM settings WHERE key=$1', [k]);
    else await setSetting(k, v);
  }
  await db.end();
});

test('alerte admin « sans Œil » : le texte affiche le réglage réel (7 h) et le nombre de candidatures visibles', { skip: SKIP }, async () => {
  const { runStaleMissions } = require('../src/jobs/staleMissions');
  const { invalidateSettingsCache } = require('../src/utils/settings');
  invalidateSettingsCache();

  const m = await makeMission(ids.clients[0], { hoursOld: 8, title: 'alerte-7h' });
  await interest(m, ids.oeils[0]);                 // 1 candidature visible
  await runStaleMissions(db, null);

  const { rows } = await db.query(
    `SELECT title, body, params FROM notifications WHERE mission_id=$1 AND title_key='staleMissionAdminTitle'`, [m]);
  assert.ok(rows.length >= 1, 'une alerte admin est créée');
  for (const r of rows) {
    assert.equal(r.title, '⏳ Mission sans Œil depuis 7 h');
    assert.match(r.body, /depuis plus de 7 h\. 1 candidature\(s\) reçue\(s\)\./);
    assert.doesNotMatch(r.body, /12/);
    assert.equal(Number(r.params.hours), 7);
    assert.equal(Number(r.params.count), 1);
  }
});

test('alerte client : envoyée seulement sans candidature visible', { skip: SKIP }, async () => {
  const { runStaleMissions } = require('../src/jobs/staleMissions');
  const sans = await makeMission(ids.clients[0], { hoursOld: 8, title: 'client-sans-candidat' });
  const avec = await makeMission(ids.clients[0], { hoursOld: 8, title: 'client-avec-candidat' });
  await interest(avec, ids.oeils[1]);
  await runStaleMissions(db, null);

  const { rows: sansRows } = await db.query(
    `SELECT body, params FROM notifications WHERE mission_id=$1 AND title_key='staleMissionClientTitle'`, [sans]);
  assert.equal(sansRows.length, 1, 'alerte client envoyée sans candidature');
  assert.match(sansRows[0].body, /depuis 7 h/);
  assert.equal(Number(sansRows[0].params.hours), 7);

  const { rows: avecRows } = await db.query(
    `SELECT 1 FROM notifications WHERE mission_id=$1 AND title_key='staleMissionClientTitle'`, [avec]);
  assert.equal(avecRows.length, 0, 'pas d\'alerte client quand une candidature est visible');
});

test('comptage : une candidature déclinée ou d\'un Œil non vérifié n\'est pas comptée', { skip: SKIP }, async () => {
  const { countClientVisibleCandidates } = require('../src/utils/candidates');
  const unverified = await makeUser('oeil', { verified: false });
  ids.oeils.push(unverified);
  const m = await makeMission(ids.clients[0], { hoursOld: 1, title: 'comptage' });
  await interest(m, ids.oeils[2]);                       // visible
  await interest(m, unverified);                         // non vérifié → exclu
  await interest(m, ids.oeils[0], { declined: true });   // décliné → exclu (déjà présent ailleurs : pas de doublon)
  const { rows: [mission] } = await db.query('SELECT id, scheduled_at, transferred_from FROM missions WHERE id=$1', [m]);
  assert.equal(await countClientVisibleCandidates(db, mission), 1);
});

test('rappel « toujours sans Œil » : une seule fois, uniquement aux Œils notifiés qui n\'ont pas postulé', { skip: SKIP }, async () => {
  const { checkUnfilledMissionReminder } = require('../src/routes/missions');
  const { invalidateSettingsCache } = require('../src/utils/settings');
  invalidateSettingsCache();
  const m = await makeMission(ids.clients[0], { hoursOld: 3, title: 'rappel-d1' });
  // Les Œils 0 et 1 ont reçu « Nouvelle mission » à la création ; l'Œil 0 a postulé depuis.
  for (const o of [ids.oeils[0], ids.oeils[1]]) {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, mission_id, title_key, body_key)
       VALUES ($1, 'Nouvelle mission', 'x', 'mission', $2, 'newMissionAvailableTitle', 'newMissionBody')`, [o, m]);
  }
  await interest(m, ids.oeils[0]);
  await checkUnfilledMissionReminder(db, null);
  await checkUnfilledMissionReminder(db, null); // second passage : aucun doublon

  const { rows } = await db.query(
    `SELECT user_id, title, body FROM notifications WHERE mission_id=$1 AND title_key='missionStillUnfilledOeilTitle'`, [m]);
  assert.equal(rows.length, 1, 'un seul rappel, à l\'Œil qui n\'a pas postulé');
  assert.equal(rows[0].user_id, ids.oeils[1]);
  assert.equal(rows[0].title, `Toujours sans Œil : « ${RUN} rappel-d1 »`);
});

test('différé : une notification mise en file part à échéance et la ligne disparaît', { skip: SKIP }, async () => {
  const { runDeferredNotifications } = require('../src/jobs/deferredNotifications');
  const title = `${RUN} différée`;
  await db.query(
    `INSERT INTO deferred_notifications (deliver_at, payload) VALUES (NOW() - INTERVAL '1 minute', $1)`,
    [JSON.stringify({ userId: ids.clients[0], title, body: 'corps', type: 'info', missionId: null,
      actionType: null, titleKey: null, bodyKey: null, params: null, pushOptions: null })]);
  await runDeferredNotifications(db, null);
  const { rows: sent } = await db.query('SELECT 1 FROM notifications WHERE user_id=$1 AND title=$2', [ids.clients[0], title]);
  assert.equal(sent.length, 1, 'la notification différée est envoyée');
  const { rows: left } = await db.query(`SELECT 1 FROM deferred_notifications WHERE payload->>'title' = $1`, [title]);
  assert.equal(left.length, 0, 'la ligne de file est supprimée après envoi');
});

test('différé : une notification future reste en file (survit à un redémarrage : table en base)', { skip: SKIP }, async () => {
  const { runDeferredNotifications } = require('../src/jobs/deferredNotifications');
  const title = `${RUN} future`;
  await db.query(
    `INSERT INTO deferred_notifications (deliver_at, payload) VALUES (NOW() + INTERVAL '1 hour', $1)`,
    [JSON.stringify({ userId: ids.clients[0], title, body: 'corps', type: 'info' })]);
  await runDeferredNotifications(db, null);
  const { rows: sent } = await db.query('SELECT 1 FROM notifications WHERE user_id=$1 AND title=$2', [ids.clients[0], title]);
  assert.equal(sent.length, 0);
  const { rows: left } = await db.query(`SELECT 1 FROM deferred_notifications WHERE payload->>'title' = $1`, [title]);
  assert.equal(left.length, 1);
});

test('validateur : stale_mission_hours ne peut pas descendre sous 6 h', { skip: SKIP }, async () => {
  const { validateSettingValue } = require('../src/config/settingValidators');
  assert.notEqual(validateSettingValue('stale_mission_hours', '4'), null);
  assert.equal(validateSettingValue('stale_mission_hours', '6'), null);
  assert.notEqual(validateSettingValue('quiet_hours_start', '24'), null);
  assert.equal(validateSettingValue('quiet_hours_end', '7'), null);
});
