// Test de bout en bout (chantier retrait → republication, 2026-10-05) — PUT /api/directory/admin/reports/:id
// avec la VRAIE route et la VRAIE base locale. Seuls l'authentification, la permission et le fetch vers
// Vercel sont simulés. Lancé à la main :
//   node scripts/directory-import/test-retrait-rebuild-route.js
// Refuse de tourner si DATABASE_URL ne pointe pas sur localhost. Toutes les lignes créées portent le
// préfixe zz-rebuild-<tag> et sont supprimées à la fin, même en cas d'échec.
require('dotenv').config();
const crypto = require('crypto');
const assert = require('assert');
const path = require('path');
const express = require('express');
const { getDb } = require('../../src/db/schema');
const { createDirectoryRebuild } = require('../../src/utils/directoryRebuild');

const HOOK = 'https://api.vercel.test/v1/integrations/deploy/fake-token';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY_MS = 60;

// ── Stubs : authentification, permission, et rebuild (instance réelle, env/fetch injectés) ──
const src = path.join(__dirname, '..', '..', 'src');
let adminId = null;
let rebuild = null; // instance courante, remplacée par scénario
function stubModule(rel, exports) {
  const file = require.resolve(path.join(src, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stubModule('middleware/auth.js', { authenticate: (req, res, next) => { req.user = { id: adminId }; next(); } });
stubModule('middleware/permissions.js', { requirePermission: () => (req, res, next) => next() });
stubModule('utils/directoryRebuild.js', { directoryRebuild: { request: () => rebuild.request() } });
const router = require('../../src/routes/directory');

function fakeFetch(status = 200) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: status < 300, status }; };
  fn.calls = calls;
  return fn;
}

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok  ${label}`); }
  catch (e) { failures++; console.log(`  KO  ${label} — ${e.message}`); }
}

async function main() {
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (!['localhost', '127.0.0.1'].includes(host)) throw new Error(`refus : DATABASE_URL pointe sur "${host}", test réservé à localhost`);

  const db = getDb();
  const tag = crypto.randomBytes(4).toString('hex');
  const prefix = `zz-rebuild-${tag}`;
  adminId = (await db.query('SELECT id FROM users ORDER BY created_at LIMIT 1')).rows[0].id;
  const categoryId = (await db.query('SELECT id FROM directory_categories WHERE is_published=true ORDER BY sort_order LIMIT 1')).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/directory', router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/directory/admin/reports`;

  let seq = 0;
  // Crée une fiche publiée + un signalement en attente, renvoie { reportId, overtureId }.
  async function seed(type = 'retrait') {
    seq++;
    const id = `${prefix}-e${seq}`;
    const overtureId = `${prefix}-o${seq}`;
    await db.query(
      `INSERT INTO directory_establishments (id, overture_id, primary_source, slug, name, category_id, city, status)
       VALUES ($1,$2,'overture',$1,$3,$4,'Rabat','published')`,
      [id, overtureId, `Fiche test ${seq} ${prefix}`, categoryId]
    );
    const reportId = `${prefix}-r${seq}`;
    await db.query(
      `INSERT INTO directory_reports (id, establishment_id, type, message) VALUES ($1,$2,$3,'test automatique')`,
      [reportId, id, type]
    );
    return { id, reportId, overtureId };
  }
  async function act(reportId, action = 'actioned') {
    const res = await fetch(`${base}/${reportId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    });
    return { status: res.status, body: await res.json() };
  }
  const statusOf = async (id) => (await db.query('SELECT status FROM directory_establishments WHERE id=$1', [id])).rows[0].status;
  const excluded = async (overtureId) =>
    (await db.query(`SELECT 1 FROM directory_exclusions WHERE source='overture' AND source_id=$1`, [overtureId])).rowCount === 1;

  try {
    console.log('Scénario A — hook présent, rafale de 3 retraits :');
    const fA = fakeFetch(200);
    rebuild = createDirectoryRebuild({ env: { VERCEL_DEPLOY_HOOK_URL: HOOK }, fetchImpl: fA, delayMs: DELAY_MS });
    const burst = [await seed(), await seed(), await seed()];
    const responses = [];
    for (const s of burst) responses.push(await act(s.reportId));
    await check('chaque retrait répond 200 avec rebuild_scheduled=true', () => {
      for (const r of responses) { assert.strictEqual(r.status, 200); assert.strictEqual(r.body.rebuild_scheduled, true); }
    });
    await check('les 3 fiches sont passées en removed et exclues', async () => {
      for (const s of burst) { assert.strictEqual(await statusOf(s.id), 'removed'); assert.ok(await excluded(s.overtureId)); }
    });
    await wait(DELAY_MS * 3);
    await check('rafale de 3 → 2 appels (1 immédiat + 1 en fin de fenêtre), en POST', () => {
      assert.strictEqual(fA.calls.length, 2, `attendu 2 appels, obtenu ${fA.calls.length}`);
      for (const c of fA.calls) { assert.strictEqual(c.url, HOOK); assert.strictEqual(c.opts.method, 'POST'); }
    });

    console.log('Scénario B — hook en échec HTTP 500 :');
    const fB = fakeFetch(500);
    rebuild = createDirectoryRebuild({ env: { VERCEL_DEPLOY_HOOK_URL: HOOK }, fetchImpl: fB, delayMs: DELAY_MS });
    const sB = await seed();
    const rB = await act(sB.reportId);
    await wait(DELAY_MS * 3);
    await check('échec du hook : l\'action admin reste 200 ok, retrait effectif', async () => {
      assert.strictEqual(rB.status, 200); assert.strictEqual(rB.body.ok, true);
      assert.strictEqual(await statusOf(sB.id), 'removed'); assert.ok(await excluded(sB.overtureId));
      assert.strictEqual(fB.calls.length, 1);
    });

    console.log('Scénario C — variable VERCEL_DEPLOY_HOOK_URL absente :');
    const fC = fakeFetch(200);
    rebuild = createDirectoryRebuild({ env: {}, fetchImpl: fC, delayMs: DELAY_MS });
    const sC = await seed();
    const rC = await act(sC.reportId);
    await wait(DELAY_MS * 2);
    await check('variable absente : 200, rebuild_scheduled=false, aucun appel', async () => {
      assert.strictEqual(rC.status, 200); assert.strictEqual(rC.body.rebuild_scheduled, false);
      assert.strictEqual(await statusOf(sC.id), 'removed');
      assert.strictEqual(fC.calls.length, 0);
    });

    console.log('Scénario D — signalement « erreur » (pas un retrait) :');
    const fD = fakeFetch(200);
    rebuild = createDirectoryRebuild({ env: { VERCEL_DEPLOY_HOOK_URL: HOOK }, fetchImpl: fD, delayMs: DELAY_MS });
    const sD = await seed('erreur');
    const rD = await act(sD.reportId);
    await wait(DELAY_MS * 2);
    await check('erreur : pas de rebuild, fiche inchangée', async () => {
      assert.strictEqual(rD.status, 200); assert.strictEqual(rD.body.rebuild_scheduled, false);
      assert.strictEqual(await statusOf(sD.id), 'published');
      assert.strictEqual(fD.calls.length, 0);
    });
  } finally {
    server.close();
    // Nettoyage strict : uniquement les lignes de CE run (préfixe avec le tag).
    await db.query(`DELETE FROM directory_reports WHERE id LIKE $1`, [`${prefix}%`]);
    await db.query(`DELETE FROM directory_exclusions WHERE source_id LIKE $1`, [`${prefix}%`]);
    await db.query(`DELETE FROM directory_establishments WHERE id LIKE $1`, [`${prefix}%`]);
  }

  if (failures) { console.log(`\n${failures} échec(s)`); process.exitCode = 1; }
  else console.log('\nTous les tests de route passent.');
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
