// Diffusion de création à une heure NOCTURNE simulée (00 h 30 à Casablanca) :
// une mission URGENTE part immédiatement, une mission non urgente est reportée (plage de silence).
// Base réelle (DATABASE_URL), données préfixées, nettoyage en fin de run. Sans push ni WhatsApp.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

process.env.WASEL_API_KEY = '';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';

const ROOT = path.join(__dirname, '..');
const ENV = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '';
const m = ENV.match(/^DATABASE_URL=(.*)$/m);
const URL_DB = m ? m[1].trim() : process.env.DATABASE_URL;
const SKIP = URL_DB ? false : 'DATABASE_URL absente';
const RUN = 'TSTU_' + Date.now().toString(36);
// 6 octobre 2026, 23 h 30 UTC = 00 h 30 à Casablanca : plage de silence (22 h – 7 h).
const NIGHT = new Date('2026-10-06T23:30:00Z');

let db;
const ids = { missions: [], users: [] };
// Réglages de plage fixés explicitement (les autres fichiers de test peuvent les modifier).
const saved = {};
async function setQuiet(start, end) {
  for (const [k, v] of [['quiet_hours_start', start], ['quiet_hours_end', end]]) {
    if (!(k in saved)) {
      const { rows } = await db.query('SELECT value FROM settings WHERE key=$1', [k]);
      saved[k] = rows.length ? rows[0].value : null;
    }
    await db.query(`INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [k, v]);
  }
}

before(async () => {
  if (SKIP) return;
  const { Pool } = require('pg');
  db = new Pool({ connectionString: URL_DB, max: 2 });
  const oeil = randomUUID();
  await db.query(
    `INSERT INTO users (id,email,password,role,first_name,last_name,city) VALUES ($1,$2,'x','oeil','Test','Oeil','Rabat')`,
    [oeil, `${RUN}_oeil@test.invalid`]);
  await db.query(
    `INSERT INTO oeil_profiles (user_id,is_verified,is_available,rating_avg,rating_count,total_missions)
     VALUES ($1,true,true,4.5,1,1)`, [oeil]);
  ids.users.push(oeil);
  ids.oeil = oeil;
  const client = randomUUID();
  await db.query(
    `INSERT INTO users (id,email,password,role,first_name,last_name,city,phone) VALUES ($1,$2,'x','client','Test','Client','Rabat','+212600000008')`,
    [client, `${RUN}_client@test.invalid`]);
  ids.users.push(client);
  ids.client = client;
});

after(async () => {
  mock.timers.reset();
  if (SKIP || !db) return;
  if (ids.missions.length) {
    await db.query('DELETE FROM notifications WHERE mission_id = ANY($1::text[])', [ids.missions]);
    await db.query('DELETE FROM deferred_notifications WHERE payload->>\'missionId\' = ANY($1::text[])', [ids.missions]);
    await db.query('DELETE FROM missions WHERE id = ANY($1::text[])', [ids.missions]);
  }
  await db.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids.users]);
  await db.query('DELETE FROM oeil_profiles WHERE user_id = ANY($1::text[])', [ids.users]);
  await db.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids.users]);
  for (const [k, v] of Object.entries(saved)) {
    if (v === null) await db.query('DELETE FROM settings WHERE key=$1', [k]);
    else await db.query('UPDATE settings SET value=$2 WHERE key=$1', [k, v]);
  }
  await db.end();
});

async function makeMission(isUrgent) {
  const id = randomUUID();
  // Demain 10 h à Casablanca (UTC+1 en octobre) : créneau loin de la fin de plage.
  const when = new Date('2026-10-07T09:00:00Z');
  await db.query(
    `INSERT INTO missions (id, client_id, type, status, title, address, city, scheduled_at, price, commission, oeil_earning, is_urgent)
     VALUES ($1,$2,'immobilier','pending',$3,'Adresse test','Rabat',$4,200,20,180,$5)`,
    [id, ids.client, `${RUN} ${isUrgent ? 'urgente' : 'normale'}`, when, isUrgent]);
  ids.missions.push(id);
  return { id, city: 'Rabat', title: `${RUN} ${isUrgent ? 'urgente' : 'normale'}`, price: 200, is_urgent: isUrgent, scheduled_at: when };
}

test('mission URGENTE à 00 h 30 : diffusée immédiatement à l\'Œil', { skip: SKIP }, async () => {
  const { notifyNewMission } = require('../src/routes/missions');
  await setQuiet(22, 7);
  mock.timers.enable({ apis: ['Date'], now: NIGHT });
  try {
    const mission = await makeMission(true);
    await notifyNewMission(db, mission, null, null);
    const { rows } = await db.query(
      `SELECT title_key FROM notifications WHERE mission_id=$1 AND user_id=$2`, [mission.id, ids.oeil]);
    assert.equal(rows.length, 1, 'notification immédiate pour une mission urgente, même la nuit');
    assert.equal(rows[0].title_key, 'newMissionUrgentTitle');
  } finally {
    mock.timers.reset();
  }
});

test('mission NON urgente à 00 h 30 : reportée (file), pas d\'envoi immédiat', { skip: SKIP }, async () => {
  const { notifyNewMission } = require('../src/routes/missions');
  await setQuiet(22, 7);
  mock.timers.enable({ apis: ['Date'], now: NIGHT });
  try {
    const mission = await makeMission(false);
    await notifyNewMission(db, mission, null, null);
    const { rows: sent } = await db.query(
      `SELECT 1 FROM notifications WHERE mission_id=$1 AND user_id=$2`, [mission.id, ids.oeil]);
    assert.equal(sent.length, 0, 'pas de notification immédiate la nuit pour une mission normale');
    const { rows: queued } = await db.query(
      `SELECT deliver_at FROM deferred_notifications WHERE payload->>'missionId' = $1 AND payload->>'userId' = $2`,
      [mission.id, ids.oeil]);
    assert.equal(queued.length, 1, 'notification mise en file');
    // Fin de plage : 7 h Casablanca le 7 octobre = 06:00 UTC.
    assert.equal(new Date(queued[0].deliver_at).toISOString(), '2026-10-07T06:00:00.000Z');
  } finally {
    mock.timers.reset();
  }
});
