// Administrations — étape finale : upsert en base (out/merged_admin.json,
// out/neighborhoods_admin_new.json). Même garanties que run-import.js (slug stable, exclusion
// permanente, fiche disparue jamais supprimée) — voir ce fichier pour le détail des commentaires,
// non répétés ici. Différences : 4 colonnes d'identité possibles (overture_id/foursquare_id/
// mtnra_id/osm_id, au moins une non nulle) au lieu de 2 ; "disparue" filtré sur domain='administration'.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');
const { normalizeCore } = require('./keyword-rules');

const OUT_DIR = path.join(__dirname, 'out');
const OSM_UNAVAILABLE_FLAG = path.join(OUT_DIR, 'osm_admin_unavailable.flag');

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

async function isExcluded(client, rec) {
  const { rows } = await client.query(
    `SELECT 1 FROM directory_exclusions WHERE
       (source='mtnra' AND source_id=$1) OR (source='overture' AND source_id=$2)
       OR (source='foursquare' AND source_id=$3) OR (source='osm_overpass' AND source_id=$4)`,
    [rec.mtnra_id, rec.overture_id, rec.foursquare_id, rec.osm_id]
  );
  return rows.length > 0;
}

async function findExisting(client, rec) {
  const { rows } = await client.query(
    `SELECT * FROM directory_establishments WHERE
       (mtnra_id IS NOT NULL AND mtnra_id=$1) OR (overture_id IS NOT NULL AND overture_id=$2)
       OR (foursquare_id IS NOT NULL AND foursquare_id=$3) OR (osm_id IS NOT NULL AND osm_id=$4)`,
    [rec.mtnra_id, rec.overture_id, rec.foursquare_id, rec.osm_id]
  );
  return rows[0] || null;
}

async function upsertNewMtnraNeighborhoods(client, neighborhoods) {
  for (const nb of neighborhoods) {
    await client.query(
      `INSERT INTO directory_neighborhoods (id, city, name_fr, name_ar, osm_type, osm_id, centroid_lat, centroid_lng, source)
       VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6,'mtnra_provided')
       ON CONFLICT (city, name_fr) WHERE source='mtnra_provided'
       DO UPDATE SET name_ar=EXCLUDED.name_ar, centroid_lat=EXCLUDED.centroid_lat, centroid_lng=EXCLUDED.centroid_lng`,
      [nb.id, nb.city, nb.name_fr, nb.name_ar, nb.centroid_lat, nb.centroid_lng]
    );
  }
}

async function main() {
  const merged = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'merged_admin.json'), 'utf8'));
  const newNeighborhoods = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'neighborhoods_admin_new.json'), 'utf8'));

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const runStart = new Date();
  const { rows: runRows } = await client.query(
    `INSERT INTO directory_import_runs (started_at, overture_release, foursquare_release, records_seen_overture, records_seen_foursquare, status)
     VALUES ($1,'admin-mtnra-2021','admin-cross-ref',$2,$3,'running') RETURNING id`,
    [runStart, merged.length, merged.length]
  );
  const runId = runRows[0].id;

  try {
    await upsertNewMtnraNeighborhoods(client, newNeighborhoods);

    let created = 0, updated = 0, excludedSkipped = 0;
    for (const rec of merged) {
      if (await isExcluded(client, rec)) { excludedSkipped++; continue; }

      const existing = await findExisting(client, rec);
      if (existing) {
        await client.query(
          `UPDATE directory_establishments SET
             name=$1, category_id=$2, city=$3, neighborhood_id=$4, address=$5, phone=$6, website=$7,
             lat=$8, lng=$9, confidence=$10,
             mtnra_id=COALESCE(mtnra_id,$11), overture_id=COALESCE(overture_id,$12),
             foursquare_id=COALESCE(foursquare_id,$13), osm_id=COALESCE(osm_id,$14),
             status = CASE WHEN status='pending_review' THEN 'published' ELSE status END,
             last_seen_at=NOW(), updated_at=NOW()
           WHERE id=$15`,
          [rec.name, rec.category_id, rec.city, rec.neighborhood_id, rec.address, rec.phone, rec.website,
           rec.lat, rec.lng, rec.confidence, rec.mtnra_id, rec.overture_id, rec.foursquare_id, rec.osm_id, existing.id]
        );
        updated++;
      } else {
        const id = crypto.randomUUID();
        const baseSlug = slugify(`${rec.name}-${rec.city}`);
        const slug = await uniqueSlug(client, baseSlug);
        await client.query(
          `INSERT INTO directory_establishments
             (id, mtnra_id, overture_id, foursquare_id, osm_id, primary_source, slug, name, category_id,
              city, neighborhood_id, address, phone, website, lat, lng, confidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [id, rec.mtnra_id, rec.overture_id, rec.foursquare_id, rec.osm_id, rec.primary_source, slug,
           rec.name, rec.category_id, rec.city, rec.neighborhood_id, rec.address, rec.phone, rec.website,
           rec.lat, rec.lng, rec.confidence]
        );
        created++;
      }
    }

    // 'centres_sante_publics' (domain='sante', Phase 3 #1) est produit par CE pipeline (MTNRA),
    // pas par run-import.js (santé Overture/Foursquare) — doit être inclus ici, sinon ni l'un ni
    // l'autre run ne détecterait jamais sa disparition d'une source. Bug de portée du même type que
    // celui déjà corrigé sur run-import.js (voir son commentaire) — trouvé en écrivant ce correctif.
    //
    // Phase 5 sexies (2026-10-02), décision BOSS : si Overpass était indisponible ce run (flag posé
    // par fetch-osm-admin.js), les banques dont primary_source='osm_overpass' (trouvées UNIQUEMENT
    // par OSM, jamais côté MTNRA ni Foursquare — merge-classify-admin.js §3) sont ABSENTES de
    // merged_admin.json ce run, pas parce qu'elles ont disparu, mais parce que leur SEULE source est
    // indisponible. Sans cette exclusion, elles seraient marquées à tort 'pending_review' à chaque
    // panne Overpass. Une source indisponible ce mois-ci ne doit jamais faire passer ses propres
    // fiches en revue.
    const osmUnavailable = fs.existsSync(OSM_UNAVAILABLE_FLAG);
    if (osmUnavailable) console.log("Overpass indisponible ce run — fiches primary_source='osm_overpass' exclues de la détection \"disparue\".");
    const { rows: disappearedRows } = await client.query(
      `UPDATE directory_establishments e SET status='pending_review', updated_at=NOW()
       FROM directory_categories c
       WHERE e.category_id = c.id AND (c.domain = 'administration' OR c.id = 'centres_sante_publics')
         AND e.last_seen_at < $1 AND e.status='published'
         ${osmUnavailable ? "AND e.primary_source <> 'osm_overpass'" : ''}
       RETURNING e.id`,
      [runStart]
    );

    await client.query(
      `UPDATE directory_import_runs SET finished_at=NOW(), records_created=$1, records_updated=$2,
         records_excluded_skipped=$3, neighborhoods_matched=$4, neighborhoods_total=$4, status='success'
       WHERE id=$5`,
      [created, updated, excludedSkipped, newNeighborhoods.length, runId]
    );

    console.log('Import administrations terminé — run', runId);
    console.log('  créées:', created, '| mises à jour:', updated, '| exclues (jamais réinsérées):', excludedSkipped);
    console.log('  disparues (passées en pending_review):', disappearedRows.length);
  } catch (e) {
    await client.query(`UPDATE directory_import_runs SET finished_at=NOW(), status='failed', error_message=$1 WHERE id=$2`, [e.message, runId]);
    throw e;
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
module.exports = { main, slugify };
