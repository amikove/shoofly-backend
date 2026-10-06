// Rappel « mission à vérifier » (jobs/missionToVerify.js) : une seule notification par mission et par
// admin, quel que soit le nombre de passages du cron ; backfill run-once des missions déjà en retard.
// Base réelle (DATABASE_URL), données préfixées, nettoyage en fin de run. Sans push ni WhatsApp.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

process.env.WASEL_API_KEY = '';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';
delete process.env.NOTIFICATIONS_LIVE; // garde fermée : aucun envoi réel

const ROOT = path.join(__dirname, '..');
const ENV = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '';
const m = ENV.match(/^DATABASE_URL=(.*)$/m);
const URL_DB = m ? m[1].trim() : process.env.DATABASE_URL;
const SKIP = URL_DB ? false : 'DATABASE_URL absente';
const RUN = 'TSTV_' + Date.now().toString(36);

let db;
const ids = { missions: [], users: [] };

before(async () => {
  if (SKIP) return;
  const { Pool } = require('pg');
  db = new Pool({ connectionString: URL_DB, max: 2 });
  // DDL idempotent (identique à db/schema.js) : la colonne doit exister avant le premier passage.
  await db.query('ALTER TABLE missions ADD COLUMN IF NOT EXISTS to_verify_notified_at TIMESTAMPTZ');
  const client = randomUUID();
  await db.query(`INSERT INTO users (id,email,password,role,first_name,last_name,city,phone) VALUES ($1,$2,'x','client','Test','Client','Rabat','+212600000007')`,
    [client, `${RUN}_client@test.invalid`]);
  const oeil = randomUUID();
  await db.query(`INSERT INTO users (id,email,password,role,first_name,last_name,city) VALUES ($1,$2,'x','oeil','Test','Oeil','Rabat')`,
    [oeil, `${RUN}_oeil@test.invalid`]);
  ids.users.push(client, oeil);
  ids.client = client;
  ids.oeil = oeil;
  // Admins actifs de la base : leur nombre sert d'attendu.
  const { rows } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
  ids.admins = rows.map((r) => r.id);
});

after(async () => {
  if (SKIP || !db) return;
  if (ids.missions.length) {
    await db.query('DELETE FROM notifications WHERE mission_id = ANY($1::text[])', [ids.missions]);
    await db.query('DELETE FROM missions WHERE id = ANY($1::text[])', [ids.missions]);
  }
  await db.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids.users]);
  await db.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids.users]);
  await db.end();
});

// Mission en retard : active, créneau il y a 30 h (au-delà du seuil de 24 h).
async function overdueMission(title, { notified } = {}) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO missions (id, client_id, oeil_id, type, status, title, address, city, scheduled_at,
                           price, commission, oeil_earning, to_verify_notified_at)
     VALUES ($1,$2,$3,'immobilier','active',$4,'Adresse test','Rabat', NOW() - INTERVAL '30 hours',
             200,20,180, CASE WHEN $5::boolean THEN NOW() ELSE NULL END)`,
    [id, ids.client, ids.oeil, `${RUN} ${title}`, !!notified]);
  ids.missions.push(id);
  return id;
}

test('trois passages du cron : une seule notification par admin pour la mission', { skip: SKIP }, async () => {
  const { runMissionToVerify } = require('../src/jobs/missionToVerify');
  const id = await overdueMission('trois-passages');
  for (let i = 0; i < 3; i++) await runMissionToVerify(db, null);
  const { rows } = await db.query(
    `SELECT user_id, COUNT(*)::int AS n FROM notifications
     WHERE mission_id = $1 AND title_key = 'missionToVerifyAdminTitle' GROUP BY user_id`, [id]);
  assert.equal(rows.length, ids.admins.length, 'chaque admin est notifié');
  for (const r of rows) assert.equal(r.n, 1, 'une seule notification par admin');
});

test('backfill run-once : une mission déjà en retard n\'est pas notifiée au déploiement', { skip: SKIP }, async () => {
  const { markOverdueToVerifyAsNotified } = require('../src/db/toVerifyBackfill');
  const { runMissionToVerify } = require('../src/jobs/missionToVerify');
  const id = await overdueMission('backfill');
  const marked = await markOverdueToVerifyAsNotified(db, 24);
  assert.ok(marked >= 1);
  const { rows: [row] } = await db.query('SELECT to_verify_notified_at FROM missions WHERE id=$1', [id]);
  assert.notEqual(row.to_verify_notified_at, null);
  await runMissionToVerify(db, null);
  const { rows: n } = await db.query(
    `SELECT 1 FROM notifications WHERE mission_id=$1 AND title_key='missionToVerifyAdminTitle'`, [id]);
  assert.equal(n.length, 0, 'aucune vague sur une mission marquée au déploiement');
});
