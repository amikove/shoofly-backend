// Étape 4 (finale) : upsert en base des fiches fusionnées/classées/rattachées (out/merged.json,
// out/neighborhoods.json — produits par fetch-sources.js → merge-classify.js →
// assign-neighborhoods.js, qui doivent avoir tourné avant celui-ci).
//
// Garanties (décisions BOSS, 2026-09-30) :
//   - slug STABLE : calculé UNE SEULE FOIS à la création, jamais réécrit sur un upsert (#7).
//   - exclusion PERMANENTE : une fiche dans directory_exclusions n'est jamais réinsérée, quel que
//     soit le nombre de runs suivants (#H du plan initial, confirmé #B ici).
//   - fiche disparue d'une source : jamais supprimée, marquée 'pending_review' pour revue humaine.
//   - idempotent : deux runs successifs sur les mêmes données sources ne créent aucun doublon (§D).
//
// Usage : node run-import.js  (lit process.env.DATABASE_URL, comme le reste du backend).
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

async function isExcluded(client, overtureId, foursquareId) {
  const { rows } = await client.query(
    `SELECT 1 FROM directory_exclusions WHERE (source='overture' AND source_id=$1) OR (source='foursquare' AND source_id=$2)`,
    [overtureId, foursquareId]
  );
  return rows.length > 0;
}

async function findExisting(client, overtureId, foursquareId) {
  const { rows } = await client.query(
    `SELECT * FROM directory_establishments WHERE (overture_id IS NOT NULL AND overture_id=$1) OR (foursquare_id IS NOT NULL AND foursquare_id=$2)`,
    [overtureId, foursquareId]
  );
  return rows[0] || null;
}

async function upsertNeighborhoods(client, neighborhoods) {
  let matched = 0;
  for (const nb of neighborhoods) {
    await client.query(
      `INSERT INTO directory_neighborhoods (id, city, name_fr, name_ar, osm_type, osm_id, centroid_lat, centroid_lng, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (osm_type, osm_id) DO UPDATE SET name_fr=EXCLUDED.name_fr, name_ar=EXCLUDED.name_ar,
         centroid_lat=EXCLUDED.centroid_lat, centroid_lng=EXCLUDED.centroid_lng`,
      [nb.id, nb.city, nb.name_fr, nb.name_ar, nb.osm_type, nb.osm_id, nb.centroid_lat, nb.centroid_lng, nb.source]
    );
    matched++;
  }
  return matched;
}

async function main() {
  const merged = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'merged.json'), 'utf8'));
  const neighborhoods = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'neighborhoods.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'fetch_meta.json'), 'utf8'));

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const runStart = new Date();
  const { rows: runRows } = await client.query(
    `INSERT INTO directory_import_runs (started_at, overture_release, foursquare_release, records_seen_overture, records_seen_foursquare, status)
     VALUES ($1,$2,$3,$4,$5,'running') RETURNING id`,
    [runStart, meta.overture_release, meta.foursquare_release, meta.overture_count, meta.foursquare_count]
  );
  const runId = runRows[0].id;

  try {
    await upsertNeighborhoods(client, neighborhoods);

    let created = 0, updated = 0, excludedSkipped = 0, markedClosed = 0;
    for (const rec of merged) {
      if (await isExcluded(client, rec.overture_id, rec.foursquare_id)) { excludedSkipped++; continue; }
      if (rec.probably_closed) markedClosed++;

      const existing = await findExisting(client, rec.overture_id, rec.foursquare_id);
      if (existing) {
        await client.query(
          `UPDATE directory_establishments SET
             name=$1, category_id=$2, city=$3, neighborhood_id=$4, address=$5, phone=$6, website=$7,
             lat=$8, lng=$9, confidence=$10, probably_closed=$11, closed_signal_source=$12,
             overture_id=COALESCE(overture_id,$13), foursquare_id=COALESCE(foursquare_id,$14),
             status = CASE WHEN status='pending_review' THEN 'published' ELSE status END,
             last_seen_at=NOW(), updated_at=NOW()
           WHERE id=$15`,
          [rec.name, rec.category_id, rec.city, rec.neighborhood_id, rec.address, rec.phone, rec.website,
           rec.lat, rec.lng, rec.confidence, rec.probably_closed, rec.closed_signal_source,
           rec.overture_id, rec.foursquare_id, existing.id]
        );
        updated++;
      } else {
        const id = crypto.randomUUID();
        const baseSlug = slugify(`${rec.name}-${rec.city}`);
        const slug = await uniqueSlug(client, baseSlug);
        await client.query(
          `INSERT INTO directory_establishments
             (id, overture_id, foursquare_id, slug, name, category_id, city, neighborhood_id, address,
              phone, website, lat, lng, confidence, probably_closed, closed_signal_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [id, rec.overture_id, rec.foursquare_id, slug, rec.name, rec.category_id, rec.city,
           rec.neighborhood_id, rec.address, rec.phone, rec.website, rec.lat, rec.lng, rec.confidence,
           rec.probably_closed, rec.closed_signal_source]
        );
        created++;
      }
    }

    // Fiches disparues d'une source depuis le run précédent : jamais supprimées, marquées pour
    // revue humaine (décision #H du plan initial). Ne rétrograde jamais un statut déjà 'removed'.
    // Filtré sur domain='sante' (jointure directory_categories) : ce pipeline n'importe QUE la
    // santé — sans ce filtre, un import santé marquerait à tort toutes les fiches administration
    // (importées par un run séparé, donc avec un last_seen_at plus ancien) comme disparues, et
    // vice versa. Piège trouvé en écrivant run-import-admin.js (Phase 2 bis).
    const { rows: disappearedRows } = await client.query(
      `UPDATE directory_establishments e SET status='pending_review', updated_at=NOW()
       FROM directory_categories c
       WHERE e.category_id = c.id AND c.domain = 'sante' AND e.last_seen_at < $1 AND e.status='published'
       RETURNING e.id`,
      [runStart]
    );

    await client.query(
      `UPDATE directory_import_runs SET finished_at=NOW(), records_merged_duplicates=$1,
         records_created=$2, records_updated=$3, records_marked_closed=$4, records_excluded_skipped=$5,
         neighborhoods_matched=$6, neighborhoods_total=$7, status='success'
       WHERE id=$8`,
      [meta.overture_count + meta.foursquare_count - merged.length, created, updated, markedClosed,
       excludedSkipped, neighborhoods.length, neighborhoods.length, runId]
    );

    console.log('Import terminé — run', runId);
    console.log('  créées:', created, '| mises à jour:', updated, '| exclues (jamais réinsérées):', excludedSkipped);
    console.log('  marquées probablement fermées:', markedClosed, '| disparues (passées en pending_review):', disappearedRows.length);
  } catch (e) {
    await client.query(`UPDATE directory_import_runs SET finished_at=NOW(), status='failed', error_message=$1 WHERE id=$2`, [e.message, runId]);
    throw e;
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
module.exports = { main, slugify };
