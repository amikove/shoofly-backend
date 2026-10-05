// Test (chantier retrait → republication, 2026-10-05) — module utils/directoryRebuild.js, sans base ni réseau.
//   node scripts/directory-import/test-directory-rebuild.js
// Le fetch et l'environnement sont simulés ; le délai d'anti-rafale est réduit à quelques ms.
const assert = require('assert');
const { createDirectoryRebuild } = require('../../src/utils/directoryRebuild');

const HOOK = 'https://api.vercel.test/v1/integrations/deploy/fake-token';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeFetch(status = 200, fail = null) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (fail) throw fail;
    return { ok: status >= 200 && status < 300, status };
  };
  fn.calls = calls;
  return fn;
}

// Capture console.warn/error/log pour vérifier qu'aucune URL secrète n'est journalisée.
function captureLogs(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error']) console[k] = (...a) => lines.push(a.map(String).join(' '));
  return Promise.resolve(fn()).finally(() => Object.assign(console, orig)).then((v) => ({ value: v, lines }));
}

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok  ${label}`); }
  catch (e) { failures++; console.log(`  KO  ${label} — ${e.message}`); }
}

async function main() {
  await check('1 retrait : 1 POST immédiat, rien de plus à la fin de la fenêtre, request() renvoie true', async () => {
    const f = fakeFetch(200);
    const rb = createDirectoryRebuild({ env: { VERCEL_DEPLOY_HOOK_URL: HOOK }, fetchImpl: f, delayMs: 10 });
    assert.strictEqual(rb.request(), true);
    await wait(5);
    assert.strictEqual(f.calls.length, 1, 'appel immédiat (leading)');
    await wait(40);
    assert.strictEqual(f.calls.length, 1, 'pas de second appel sans demande pendant la fenêtre');
    assert.strictEqual(f.calls[0].url, HOOK);
    assert.strictEqual(f.calls[0].opts.method, 'POST');
  });

  await check('échec HTTP (500) : journalisé, ne lève rien, pas de nouvel appel', async () => {
    const f = fakeFetch(500);
    const rb = createDirectoryRebuild({ env: { VERCEL_DEPLOY_HOOK_URL: HOOK }, fetchImpl: f, delayMs: 10 });
    const { lines } = await captureLogs(async () => { rb.request(); await wait(40); });
    assert.strictEqual(f.calls.length, 1);
    assert.ok(lines.some((l) => l.includes('HTTP 500')), 'le statut HTTP doit être journalisé');
    assert.ok(!lines.some((l) => l.includes(HOOK)), 'l\'URL du hook ne doit JAMAIS apparaître dans les logs');
  });

  await check('exception réseau : journalisée, aucune propagation (l\'action admin reste un succès)', async () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND api.vercel.test'), { name: 'TypeError' });
    const f = fakeFetch(200, err);
    const rb = createDirectoryRebuild({ env: { VERCEL_DEPLOY_HOOK_URL: HOOK }, fetchImpl: f, delayMs: 10 });
    const { lines } = await captureLogs(async () => { assert.strictEqual(rb.request(), true); await wait(40); });
    assert.strictEqual(f.calls.length, 1);
    assert.ok(lines.some((l) => l.includes('en échec')), 'l\'échec doit être journalisé');
    assert.ok(!lines.some((l) => l.includes(HOOK)));
  });

  await check('variable absente : request() renvoie false, avertissement, AUCUN appel', async () => {
    const f = fakeFetch(200);
    const rb = createDirectoryRebuild({ env: {}, fetchImpl: f, delayMs: 10 });
    const { value, lines } = await captureLogs(async () => { const v = rb.request(); await wait(40); return v; });
    assert.strictEqual(value, false);
    assert.strictEqual(f.calls.length, 0);
    assert.ok(lines.some((l) => l.includes('VERCEL_DEPLOY_HOOK_URL absent')));
  });

  await check('chaîne vide = variable absente', async () => {
    const f = fakeFetch(200);
    const rb = createDirectoryRebuild({ env: { VERCEL_DEPLOY_HOOK_URL: '' }, fetchImpl: f, delayMs: 10 });
    const { value } = await captureLogs(async () => rb.request());
    assert.strictEqual(value, false);
    await wait(30);
    assert.strictEqual(f.calls.length, 0);
  });

  await check('rafale de 3 : 1 appel immédiat, puis 1 seul en fin de fenêtre (2 au total)', async () => {
    const f = fakeFetch(200);
    const rb = createDirectoryRebuild({ env: { VERCEL_DEPLOY_HOOK_URL: HOOK }, fetchImpl: f, delayMs: 60 });
    assert.strictEqual(rb.request(), true);
    assert.strictEqual(rb.request(), true);
    assert.strictEqual(rb.request(), true);
    await wait(10);
    assert.strictEqual(f.calls.length, 1, `immédiat : attendu 1 appel, obtenu ${f.calls.length}`);
    await wait(120);
    assert.strictEqual(f.calls.length, 2, `attendu 2 appels au total, obtenu ${f.calls.length}`);
  });

  await check('après la fenêtre vide, un nouveau retrait déclenche immédiatement un rebuild', async () => {
    const f = fakeFetch(200);
    const rb = createDirectoryRebuild({ env: { VERCEL_DEPLOY_HOOK_URL: HOOK }, fetchImpl: f, delayMs: 10 });
    rb.request(); await wait(40);
    assert.strictEqual(f.calls.length, 1);
    rb.request(); await wait(5);
    assert.strictEqual(f.calls.length, 2);
  });

  if (failures) { console.log(`\n${failures} échec(s)`); process.exitCode = 1; }
  else console.log('\nTous les tests passent.');
}

main();
