// Alerte admin « mission jamais assignée, créneau dépassé » (checkPendingMissionExpiration,
// phase 1 — missions.js). Audit remboursement/cash (2026-10-07) : le texte ne doit plus promettre
// de remboursement pour une mission payée en espèces. Base réelle, données préfixées, nettoyage
// en fin de run. Sans push ni WhatsApp.
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
const RUN = 'TSTR_' + Date.now().toString(36);

let db;
const ids = { missions: [], users: [] };
const noopIo = { to: () => ({ emit: () => {} }) };

before(async () => {
  if (SKIP) return;
  const { Pool } = require('pg');
  db = new Pool({ connectionString: URL_DB, max: 2 });
  const client = randomUUID();
  await db.query(`INSERT INTO users (id,email,password,role,first_name,last_name,city,phone) VALUES ($1,$2,'x','client','Test','Client','Rabat','+212600000004')`,
    [client, `${RUN}_client@test.invalid`]);
  ids.users.push(client);
  ids.client = client;
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

// Créneau dépassé d'1 h seulement : déclenche la phase 1 (alerte admin) mais jamais la phase 2
// (annulation automatique, délai de grâce par défaut 24 h) — isole le texte de l'alerte.
async function pendingMission(paymentMethod, title) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO missions (id, client_id, type, payment_method, status, title, address, city, scheduled_at, price, commission, oeil_earning)
     VALUES ($1,$2,'immobilier',$3,'pending',$4,'Adresse test','Rabat', NOW() - INTERVAL '1 hour', 200,20,180)`,
    [id, ids.client, paymentMethod, `${RUN} ${title}`]);
  ids.missions.push(id);
  return id;
}

test('mission cash : alerte admin sans promesse de remboursement', { skip: SKIP }, async () => {
  const { checkPendingMissionExpiration } = require('../src/routes/missions');
  const id = await pendingMission('cash', 'cash');
  await checkPendingMissionExpiration(db, noopIo, null);
  const { rows } = await db.query(
    `SELECT body, body_key FROM notifications WHERE mission_id=$1 AND title_key='pendingExpiredAdminTitle'`, [id]);
  assert.ok(rows.length >= 1, 'au moins un admin notifié');
  for (const r of rows) {
    assert.equal(r.body_key, 'pendingExpiredAdminNoPaymentBody');
    assert.match(r.body, /aucun remboursement/);
    assert.doesNotMatch(r.body, /remboursement intégral/);
  }
});

test('mission payzone : alerte admin avec promesse de remboursement intégral', { skip: SKIP }, async () => {
  const { checkPendingMissionExpiration } = require('../src/routes/missions');
  const id = await pendingMission('payzone', 'payzone');
  await checkPendingMissionExpiration(db, noopIo, null);
  const { rows } = await db.query(
    `SELECT body, body_key FROM notifications WHERE mission_id=$1 AND title_key='pendingExpiredAdminTitle'`, [id]);
  assert.ok(rows.length >= 1, 'au moins un admin notifié');
  for (const r of rows) {
    assert.equal(r.body_key, 'pendingExpiredAdminBody');
    assert.match(r.body, /remboursement intégral du client/);
  }
});
