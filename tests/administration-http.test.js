// Tests HTTP des routes de modification : PUT /api/missions/:id (client) et PUT /api/missions/:id/admin-edit
// (super admin). Le serveur réel est lancé (start.js) SANS crons (tests/helpers/no-cron.js), avec les
// canaux WhatsApp et push désactivés. Données : préfixe unique, nettoyage en fin de run.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { casaWallToInstant, nextCasaDate } = require('./helpers/casa');

const ROOT = path.join(__dirname, '..');
const ENV = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '';
const envVal = (k) => {
  const m = ENV.match(new RegExp(`^${k}=(.*)$`, 'm'));
  return m ? m[1].trim() : process.env[k];
};
const URL_DB = envVal('DATABASE_URL');
const JWT_SECRET = envVal('JWT_SECRET');
const SKIP = URL_DB && JWT_SECRET ? false : 'DATABASE_URL / JWT_SECRET absents';
const PORT = 5600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = 'TSTA_' + Date.now().toString(36);
const CLIENT_CAT = 'Administrations — CNSS';
const ADOUL = 'Administrations — Adoul / Notaires';

let db, child, client, admin;
const ids = { missions: [], users: [] };

function token(user) {
  const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}

async function makeUser(role, { superAdmin = false } = {}) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users (id,email,password,role,first_name,last_name,phone,city,is_super_admin)
     VALUES ($1,$2,'x',$3,'Test','Admin',$4,'Rabat',$5)`,
    [id, `${RUN}_${id}@test.invalid`, role, role === 'client' ? '+212600000009' : null, superAdmin]);
  ids.users.push(id);
  return { id, role };
}

async function makeMission(clientId, { subcategory, when, title }) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO missions (id, client_id, type, subcategory, status, title, address, city, scheduled_at,
                           price, commission, oeil_earning)
     VALUES ($1,$2,'file_attente',$3,'pending',$4,'Adresse test','Rabat',$5,200,20,180)`,
    [id, clientId, subcategory, `${RUN} ${title}`, when]);
  ids.missions.push(id);
  return id;
}

async function call(method, url, who, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(who)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// Prochain lundi (ou samedi) à une heure donnée, heure de Casablanca, au moins 10 jours devant.
const monday = (h, m) => { const { y, mo, d } = nextCasaDate(1, 10); return casaWallToInstant(y, mo, d, h, m); };
const saturday = (h, m) => { const { y, mo, d } = nextCasaDate(6, 10); return casaWallToInstant(y, mo, d, h, m); };

async function waitHealth() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return;
    } catch { /* serveur pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('serveur de test non démarré');
}

before(async () => {
  if (SKIP) return;
  const { Pool } = require('pg');
  db = new Pool({ connectionString: URL_DB, max: 3 });
  child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'no-cron.js'), 'start.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), WASEL_API_KEY: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' },
    stdio: 'ignore',
  });
  await waitHealth();
  client = await makeUser('client');
  admin = await makeUser('admin', { superAdmin: true });
});

after(async () => {
  if (SKIP) return;
  if (child) child.kill();
  if (db && ids.missions.length) {
    await db.query('DELETE FROM notifications WHERE mission_id = ANY($1::text[])', [ids.missions]);
    await db.query('DELETE FROM missions WHERE id = ANY($1::text[])', [ids.missions]);
  }
  if (db && ids.users.length) {
    await db.query('DELETE FROM notifications WHERE user_id = ANY($1::text[])', [ids.users]);
    await db.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids.users]);
  }
  if (db) await db.end();
});

test('PUT /:id client : déplacer une mission administrative à 17 h 00 est refusé (ADMINISTRATION_HOURS)', { skip: SKIP }, async () => {
  const m = await makeMission(client.id, { subcategory: CLIENT_CAT, when: monday(10, 0), title: 'put-17h' });
  const r = await call('PUT', `/api/missions/${m}`, client, { scheduled_at: monday(17, 0).toISOString() });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(r.json.code, 'ADMINISTRATION_HOURS');
  assert.match(r.json.error, /fermées après 17 h et le week-end/);
});

test('PUT /:id client : 16 h 59 accepté', { skip: SKIP }, async () => {
  const m = await makeMission(client.id, { subcategory: CLIENT_CAT, when: monday(10, 0), title: 'put-1659' });
  const r = await call('PUT', `/api/missions/${m}`, client, { scheduled_at: monday(16, 59).toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('PUT /:id client : modifier un autre champ d\'une mission administrative existante (samedi) accepté', { skip: SKIP }, async () => {
  const m = await makeMission(client.id, { subcategory: CLIENT_CAT, when: saturday(10, 0), title: 'put-titre' });
  const r = await call('PUT', `/api/missions/${m}`, client, { title: `${RUN} titre modifié` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('PUT /:id client : Adoul / Notaires à 17 h 00 acceptée (exclue de la règle)', { skip: SKIP }, async () => {
  const m = await makeMission(client.id, { subcategory: ADOUL, when: monday(10, 0), title: 'put-adoul' });
  const r = await call('PUT', `/api/missions/${m}`, client, { scheduled_at: monday(17, 0).toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('PUT /:id/admin-edit : 17 h 00 refusé pour le super admin aussi', { skip: SKIP }, async () => {
  const m = await makeMission(client.id, { subcategory: CLIENT_CAT, when: monday(10, 0), title: 'admin-17h' });
  const r = await call('PUT', `/api/missions/${m}/admin-edit`, admin, { scheduled_at: monday(17, 0).toISOString() });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(r.json.code, 'ADMINISTRATION_HOURS');
});

test('PUT /:id/admin-edit : 16 h 59 accepté', { skip: SKIP }, async () => {
  const m = await makeMission(client.id, { subcategory: CLIENT_CAT, when: monday(10, 0), title: 'admin-1659' });
  const r = await call('PUT', `/api/missions/${m}/admin-edit`, admin, { scheduled_at: monday(16, 59).toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('PUT /:id/admin-edit : autre champ d\'une mission administrative existante (samedi) accepté', { skip: SKIP }, async () => {
  const m = await makeMission(client.id, { subcategory: CLIENT_CAT, when: saturday(10, 0), title: 'admin-titre' });
  const r = await call('PUT', `/api/missions/${m}/admin-edit`, admin, { title: `${RUN} admin titre` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});
