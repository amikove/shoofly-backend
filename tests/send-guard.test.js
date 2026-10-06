// Garde d'envoi (src/services/sendGuard.js) : sans NOTIFICATIONS_LIVE=1, aucun appel réseau pour
// chaque canal, même avec de fausses clés présentes et quel que soit NODE_ENV. Avec la variable,
// l'appel part. fetch est remplacé par un espion : aucun réseau réel.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const FAKE_KEYS = {
  WASEL_API_KEY: 'fausse-cle-wasel',
  RESEND_API_KEY: 'fausse-cle-resend',
  VAPID_PUBLIC_KEY: 'BPfauxPublicKeyPourTest0000000000000000000000000000000000000000000000000000000000',
  VAPID_PRIVATE_KEY: 'fauxPrivate000000000000000000000000000000000',
  VAPID_SUBJECT: 'mailto:test@example.invalid',
};

let savedEnv;
let fetchCalls;
let savedFetch;
let savedWarn;
let warnings;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const [k, v] of Object.entries(FAKE_KEYS)) process.env[k] = v;
  delete process.env.NOTIFICATIONS_LIVE;
  fetchCalls = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args[0]);
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  };
  warnings = [];
  savedWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(' ')); };
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  console.warn = savedWarn;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

// Modules rechargés à chaque test : leurs constantes (VAPID, clés) lisent l'environnement au chargement.
function fresh(path) {
  for (const k of Object.keys(require.cache)) if (k.includes('/src/services/') || k.includes('\\src\\services\\')) delete require.cache[k];
  return require(path);
}

const SERVICES = '../src/services/';

test('WhatsApp : sans NOTIFICATIONS_LIVE, aucun appel réseau, envoi marqué guardé', async () => {
  const { sendWhatsAppTemplateRaw } = fresh(SERVICES + 'wasel');
  const r = await sendWhatsAppTemplateRaw('mission_sans_oeil_admin', '+212600000000', ['Titre']);
  assert.equal(r.guarded, true);
  assert.equal(fetchCalls.length, 0);
  assert.ok(warnings.some((w) => w.includes('[guard] envoi bloqué') && w.includes('canal=whatsapp')));
});

test('e-mail : sans NOTIFICATIONS_LIVE, aucun appel réseau', async () => {
  const { sendEmailRaw } = fresh(SERVICES + 'email');
  const r = await sendEmailRaw('destinataire@example.invalid', 'Sujet', '<p>x</p>', 'x');
  assert.equal(r.guarded, true);
  assert.equal(fetchCalls.length, 0);
  assert.ok(warnings.some((w) => w.includes('canal=email')));
});

test('push : sans NOTIFICATIONS_LIVE, ni requête à la base ni appel réseau', async () => {
  const { sendWebPush } = fresh(SERVICES + 'push');
  const db = { query: async () => { throw new Error('la base ne doit pas être interrogée'); } };
  const ok = await sendWebPush('user-test', { title: 'Titre' }, db);
  assert.equal(ok, false);
  assert.equal(fetchCalls.length, 0);
  assert.ok(warnings.some((w) => w.includes('canal=push')));
});

test('NODE_ENV=production sans NOTIFICATIONS_LIVE : toujours bloqué', async () => {
  process.env.NODE_ENV = 'production';
  const { sendWhatsAppTemplateRaw } = fresh(SERVICES + 'wasel');
  const r = await sendWhatsAppTemplateRaw('mission_sans_oeil_admin', '+212600000000', ['Titre']);
  assert.equal(r.guarded, true);
  assert.equal(fetchCalls.length, 0);
});

test('NOTIFICATIONS_LIVE=1 : WhatsApp part bien vers le réseau (espion)', async () => {
  process.env.NOTIFICATIONS_LIVE = '1';
  const { sendWhatsAppTemplateRaw } = fresh(SERVICES + 'wasel');
  await sendWhatsAppTemplateRaw('mission_sans_oeil_admin', '+212600000000', ['Titre']);
  assert.equal(fetchCalls.length, 1);
});

test('NOTIFICATIONS_LIVE=1 : e-mail part bien vers le réseau (espion)', async () => {
  process.env.NOTIFICATIONS_LIVE = '1';
  const { sendEmailRaw } = fresh(SERVICES + 'email');
  await sendEmailRaw('destinataire@example.invalid', 'Sujet', '<p>x</p>', 'x');
  assert.equal(fetchCalls.length, 1);
});

test('ligne de démarrage : ACTIFS ou BLOQUÉS selon la variable', () => {
  const { startupStatusLine } = require(SERVICES + 'sendGuard');
  assert.match(startupStatusLine({}), /envois BLOQUÉS/);
  assert.match(startupStatusLine({ NOTIFICATIONS_LIVE: '1' }), /envois ACTIFS/);
  assert.match(startupStatusLine({ NOTIFICATIONS_LIVE: 'oui' }), /envois BLOQUÉS/);
});
