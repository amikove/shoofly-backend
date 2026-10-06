// Journal des envois WhatsApp réussis (whatsapp_send_log) : une ligne par envoi réussi (modèle,
// mission, statut), AUCUN numéro ni contenu. Réseau remplacé par un espion ; garde ouverte (test).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

process.env.WASEL_API_KEY = 'fausse-cle-wasel';
process.env.NOTIFICATIONS_LIVE = '1'; // garde ouverte pour exercer le chemin d'envoi (réseau espionné)

const ROOT = path.join(__dirname, '..');
const ENV = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '';
const m = ENV.match(/^DATABASE_URL=(.*)$/m);
const URL_DB = m ? m[1].trim() : process.env.DATABASE_URL;
const SKIP = URL_DB ? false : 'DATABASE_URL absente';
const RUN = 'TSTW_' + Date.now().toString(36);
const TEMPLATE = 'mission_sans_oeil_admin';
const PHONE = '+212600000006';

let db, savedFetch, responseOk, fetchCalls;
const ids = { missions: [], users: [] };

before(async () => {
  if (SKIP) return;
  const { Pool } = require('pg');
  db = new Pool({ connectionString: URL_DB, max: 2 });
  await db.query(`CREATE TABLE IF NOT EXISTS whatsapp_send_log (
    id BIGSERIAL PRIMARY KEY, template_name TEXT NOT NULL,
    mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'sent', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const client = randomUUID();
  await db.query(`INSERT INTO users (id,email,password,role,first_name,last_name,city,phone) VALUES ($1,$2,'x','client','Test','Client','Rabat','+212600000005')`,
    [client, `${RUN}_client@test.invalid`]);
  ids.users.push(client);
  ids.client = client;
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args[0]);
    return responseOk
      ? { ok: true, status: 200, json: async () => ({ ok: true }) }
      : { ok: false, status: 500, json: async () => ({ error: 'erreur simulée' }) };
  };
});

after(async () => {
  if (SKIP || !db) return;
  globalThis.fetch = savedFetch;
  if (ids.missions.length) {
    await db.query('DELETE FROM whatsapp_send_log WHERE mission_id = ANY($1::text[])', [ids.missions]);
    await db.query('DELETE FROM missions WHERE id = ANY($1::text[])', [ids.missions]);
  }
  await db.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids.users]);
  await db.end();
});

async function makeMission() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO missions (id, client_id, type, status, title, address, city, scheduled_at, price, commission, oeil_earning)
     VALUES ($1,$2,'immobilier','pending',$3,'Adresse test','Rabat', NOW() + INTERVAL '5 days', 200,20,180)`,
    [id, ids.client, `${RUN} mission`]);
  ids.missions.push(id);
  return id;
}

test('envoi réussi : une ligne (modèle, mission, statut sent), sans numéro', { skip: SKIP }, async () => {
  const { sendWhatsAppTemplate } = require('../src/services/wasel');
  responseOk = true; fetchCalls = [];
  const mission = await makeMission();
  const ok = await sendWhatsAppTemplate(TEMPLATE, PHONE, ['Titre'], db, { missionId: mission });
  assert.equal(ok, true);
  assert.equal(fetchCalls.length, 1);
  const { rows } = await db.query('SELECT template_name, mission_id, status FROM whatsapp_send_log WHERE mission_id=$1', [mission]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { template_name: TEMPLATE, mission_id: mission, status: 'sent' });
});

test('le journal n\'a aucune colonne pouvant contenir un numéro ou un contenu de message', { skip: SKIP }, async () => {
  const { rows } = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='whatsapp_send_log'`);
  assert.deepEqual(rows.map((r) => r.column_name).sort(), ['created_at', 'id', 'mission_id', 'status', 'template_name']);
});

test('échec : pas de ligne de succès', { skip: SKIP }, async () => {
  const { sendWhatsAppTemplate } = require('../src/services/wasel');
  responseOk = false; fetchCalls = [];
  const mission = await makeMission();
  const ok = await sendWhatsAppTemplate(TEMPLATE, PHONE, ['Titre'], db, { missionId: mission });
  assert.equal(ok, false);
  const { rows } = await db.query('SELECT 1 FROM whatsapp_send_log WHERE mission_id=$1', [mission]);
  assert.equal(rows.length, 0);
});
