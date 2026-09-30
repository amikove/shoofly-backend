// NARSA CCT — upsert final (out/narsa_cct.json). Mêmes garanties que run-import.js/-admin.js
// (slug stable, idempotent) — identité par narsa_id uniquement (source unique, pas de recoupement
// demandé pour cette catégorie). "Disparue" filtré sur category_id='visite_technique'.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');
const { normalizeCore } = require('./keyword-rules');

const OUT_DIR = path.join(__dirname, 'out');

function slugify(s) {
  return normalizeCore(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'etablissement';
}
async function uniqueSlug(client, base) {
  let candidate = base, n = 1;
  while (true) {
    const { rows } = await client.query('SELECT 1 FROM directory_establishments WHERE slug=$1', [candidate]);
    if (rows.length === 0) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}
async function isExcluded(client, narsaId) {
  const { rows } = await client.query(`SELECT 1 FROM directory_exclusions WHERE source='narsa' AND source_id=$1`, [narsaId]);
  return rows.length > 0;
}
async function findExisting(client, narsaId) {
  const { rows } = await client.query(`SELECT * FROM directory_establishments WHERE narsa_id=$1`, [narsaId]);
  return rows[0] || null;
}

async function main() {
  const narsa = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'narsa_cct.json'), 'utf8'));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const runStart = new Date();
  const { rows: runRows } = await client.query(
    `INSERT INTO directory_import_runs (started_at, overture_release, foursquare_release, records_seen_overture, records_seen_foursquare, status)
     VALUES ($1,'narsa-cct',NULL,$2,NULL,'running') RETURNING id`,
    [runStart, narsa.length]
  );
  const runId = runRows[0].id;

  try {
    let created = 0, updated = 0, excludedSkipped = 0;
    for (const rec of narsa) {
      if (await isExcluded(client, rec.narsa_id)) { excludedSkipped++; continue; }
      const existing = await findExisting(client, rec.narsa_id);
      if (existing) {
        await client.query(
          `UPDATE directory_establishments SET
             name=$1, city=$2, neighborhood_id=$3, address=$4, phone=$5, website=$6,
             lat=$7, lng=$8,
             status = CASE WHEN status='pending_review' THEN 'published' ELSE status END,
             last_seen_at=NOW(), updated_at=NOW()
           WHERE id=$9`,
          [rec.name, rec.city, rec.neighborhood_id, rec.address, rec.phone, rec.website, rec.lat, rec.lng, existing.id]
        );
        updated++;
      } else {
        const id = crypto.randomUUID();
        const baseSlug = slugify(`${rec.name}-${rec.city}`);
        const slug = await uniqueSlug(client, baseSlug);
        await client.query(
          `INSERT INTO directory_establishments
             (id, narsa_id, primary_source, slug, name, category_id, city, neighborhood_id, address,
              phone, website, lat, lng, confidence)
           VALUES ($1,$2,'narsa',$3,$4,'visite_technique',$5,$6,$7,$8,$9,$10,$11,0.6)`,
          [id, rec.narsa_id, slug, rec.name, rec.city, rec.neighborhood_id, rec.address, rec.phone, rec.website, rec.lat, rec.lng]
        );
        created++;
      }
    }

    const { rows: disappearedRows } = await client.query(
      `UPDATE directory_establishments SET status='pending_review', updated_at=NOW()
       WHERE category_id='visite_technique' AND last_seen_at < $1 AND status='published'
       RETURNING id`,
      [runStart]
    );

    await client.query(
      `UPDATE directory_import_runs SET finished_at=NOW(), records_created=$1, records_updated=$2,
         records_excluded_skipped=$3, status='success' WHERE id=$4`,
      [created, updated, excludedSkipped, runId]
    );

    console.log('Import NARSA CCT terminé — run', runId);
    console.log('  créées:', created, '| mises à jour:', updated, '| exclues:', excludedSkipped, '| disparues:', disappearedRows.length);
  } catch (e) {
    await client.query(`UPDATE directory_import_runs SET finished_at=NOW(), status='failed', error_message=$1 WHERE id=$2`, [e.message, runId]);
    throw e;
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
module.exports = { main, slugify };
