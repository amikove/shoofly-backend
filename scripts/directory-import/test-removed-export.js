// Test (chantier liens annuaire, 2026-10-05) — liste `removed` de l'export SSG. Lancé à la main :
//   node scripts/directory-import/test-removed-export.js
// Tout s'exécute dans UNE transaction annulée à la fin (ROLLBACK) : aucune ligne de test ne reste en base.
// Refuse de tourner si DATABASE_URL ne pointe pas sur localhost (jamais sur la production).
require('dotenv').config();
const crypto = require('crypto');
const assert = require('assert');
const { getDb, initDb } = require('../../src/db/schema');
const { getPublishedDirectoryData } = require('../../src/utils/directoryExport');

async function main() {
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (!['localhost', '127.0.0.1'].includes(host)) throw new Error(`refus : DATABASE_URL pointe sur "${host}", test réservé à localhost`);

  await initDb(); // applique la migration (colonne + trigger + rattrapage)

  const client = await getDb().connect();
  const tag = crypto.randomBytes(4).toString('hex');
  let failures = 0;
  async function check(label, fn) {
    try { await fn(); console.log(`  ok  ${label}`); }
    catch (e) { failures++; console.log(`  KO  ${label} — ${e.message}`); }
  }

  const firstPublishedOf = async (slug) =>
    (await client.query('SELECT first_published_at FROM directory_establishments WHERE slug=$1', [slug])).rows[0].first_published_at;
  const setStatus = (slug, status) => client.query('UPDATE directory_establishments SET status=$1 WHERE slug=$2', [status, slug]);
  const removedSlugs = async () => (await getPublishedDirectoryData(client)).removed.map((r) => r.slug);
  async function insertFiche(label, category, status) {
    const slug = `zz-test-${label}-${tag}`;
    await client.query(
      `INSERT INTO directory_establishments (id, overture_id, slug, name, category_id, city, status)
       VALUES ($1,$2,$3,$4,$5,'Rabat',$6)`,
      [crypto.randomUUID(), `zz-${label}-${tag}`, slug, `Test ${label}`, category, status]
    );
    return slug;
  }

  try {
    await client.query('BEGIN');

    // Catégorie de test DÉPUBLIÉE (jamais exportée) ; catégorie publiée existante : laboratoires.
    const depubCat = `zz_depub_${tag}`;
    await client.query(
      `INSERT INTO directory_categories (id, domain, label_fr, label_ar, schema_org_type, sort_order, is_published)
       VALUES ($1,'administration','Test dépubliée','اختبار','Thing',999,FALSE)`, [depubCat]
    );
    const pubCat = 'laboratoires';

    console.log('Cas 1 — publiée puis retirée, catégorie publiée : DOIT être dans removed');
    const A = await insertFiche('publiee-retiree', pubCat, 'published');
    const firstA = await firstPublishedOf(A);
    await check('first_published_at renseigné dès la publication (trigger)', () => assert.ok(firstA instanceof Date, 'NULL'));
    await setStatus(A, 'removed');
    await check('first_published_at inchangé après retrait', async () =>
      assert.equal((await firstPublishedOf(A)).getTime(), firstA.getTime()));
    await check('présente dans removed', async () => assert.ok((await removedSlugs()).includes(A), `absente : ${A}`));

    console.log('Cas 2 — jamais publiée (insérée pending_review) : DOIT être absente');
    const B = await insertFiche('jamais-publiee', pubCat, 'pending_review');
    await check('first_published_at reste NULL', async () => assert.equal(await firstPublishedOf(B), null));
    await check('absente de removed', async () => assert.ok(!(await removedSlugs()).includes(B)));

    console.log('Cas 3a — fiche insérée « publiée » dans une catégorie DÉPUBLIÉE : jamais publique, aucune date');
    const C0 = await insertFiche('dans-categorie-depubliee', depubCat, 'published');
    await check('first_published_at reste NULL', async () => assert.equal(await firstPublishedOf(C0), null));
    await setStatus(C0, 'removed');
    await check('absente de removed', async () => assert.ok(!(await removedSlugs()).includes(C0)));

    console.log('Cas 3b — publiée puis retirée, puis catégorie dépubliée : DOIT être absente');
    await client.query(
      `INSERT INTO directory_categories (id, domain, label_fr, label_ar, schema_org_type, sort_order, is_published)
       VALUES ($1,'sante','Test publiée','اختبار','Thing',998,TRUE)`, [`zz_pub_${tag}`]
    );
    const C = await insertFiche('categorie-depubliee-apres', `zz_pub_${tag}`, 'published');
    await check('date posée (catégorie publiée au moment de la publication)', async () => assert.ok((await firstPublishedOf(C)) instanceof Date));
    await setStatus(C, 'removed');
    await client.query('UPDATE directory_categories SET is_published=FALSE WHERE id=$1', [`zz_pub_${tag}`]);
    await check('absente de removed (catégorie désormais dépubliée)', async () => assert.ok(!(await removedSlugs()).includes(C)));

    console.log('Cas 4 — toujours publiée : ni removed');
    const D = await insertFiche('encore-publiee', pubCat, 'published');
    await check('absente de removed', async () => assert.ok(!(await removedSlugs()).includes(D)));

    console.log('Cas 5 — en attente puis publiée : date posée à la publication, pas avant');
    const E = await insertFiche('attente-puis-publiee', pubCat, 'pending_review');
    await check('NULL tant que non publiée', async () => assert.equal(await firstPublishedOf(E), null));
    await setStatus(E, 'published');
    await check('renseignée à la publication', async () => assert.ok((await firstPublishedOf(E)) instanceof Date));

    console.log(`\n${failures === 0 ? 'TOUS LES TESTS PASSENT' : failures + ' ÉCHEC(S)'}`);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error('ERREUR TEST:', e.message); process.exitCode = 1; })
  .finally(() => process.exit(process.exitCode || 0));
