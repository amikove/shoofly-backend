// Administrations — Overture, process isolé (même précaution que fetch-overture.child.js).
// Taxonomies retenues : celles identifiées en Phase 1/2 comme pertinentes pour les 10
// administrations ciblées (voir RAPPORT_ETUDE_SEO_DONNEES.md §0bis et RAPPORT_PHASE2_DONNEES.md §E).
const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');

const OVERTURE_RELEASE = '2026-09-23.0';
const LON_MIN = -6.98, LON_MAX = -6.70, LAT_MIN = 33.85, LAT_MAX = 34.12;
const DATA_DIR = path.join(__dirname, 'data').replace(/\\/g, '/');
const OUT_FILE = process.argv[2];
function jstr(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? Number(v) : v, 2); }

const ADMIN_TAXONOMIES = [
  'government_office', 'courthouse', 'police_station', 'bank_or_credit_union',
  'post_office', 'notary_public', 'community_and_government',
];

(async () => {
  const db = new duckdb.Database(':memory:');
  const con = db.connect();
  const run = (sql) => new Promise((resolve, reject) => con.all(sql, (err, rows) => err ? reject(err) : resolve(rows)));

  await run("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';");
  await run(`CREATE TABLE poly_rabat AS SELECT geom FROM ST_Read('${DATA_DIR}/boundary_rabat.geojson')`);
  await run(`CREATE TABLE poly_sale AS SELECT geom FROM ST_Read('${DATA_DIR}/boundary_sale.geojson')`);
  await run(`CREATE TABLE poly_temara AS SELECT geom FROM ST_Read('${DATA_DIR}/boundary_temara.geojson')`);
  await run(`CREATE TABLE centroids AS
    SELECT 'Rabat' AS city, ST_Centroid(geom) AS c FROM poly_rabat
    UNION ALL SELECT 'Salé', ST_Centroid(geom) FROM poly_sale
    UNION ALL SELECT 'Témara', ST_Centroid(geom) FROM poly_temara`);

  const PLACES = `read_parquet('s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=places/type=place/*', filename=false, hive_partitioning=1)`;
  const taxList = ADMIN_TAXONOMIES.map((t) => `'${t}'`).join(',');
  await run(`
    CREATE TABLE ov_raw AS
    SELECT id, geometry, confidence, websites, phones, addresses, names, taxonomy
    FROM ${PLACES}
    WHERE bbox.xmin BETWEEN ${LON_MIN} AND ${LON_MAX} AND bbox.ymin BETWEEN ${LAT_MIN} AND ${LAT_MAX}
      AND taxonomy.primary IN (${taxList})
  `);
  const rows = await run(`
    SELECT
      id AS source_id,
      names.primary AS name,
      ST_Y(geometry) AS lat, ST_X(geometry) AS lng,
      addresses[1].freeform AS address,
      phones[1] AS phone,
      websites[1] AS website,
      confidence,
      taxonomy.primary AS taxonomy_primary,
      CASE
        WHEN (SELECT ST_Contains(geom, geometry) FROM poly_rabat) THEN 'Rabat'
        WHEN (SELECT ST_Contains(geom, geometry) FROM poly_sale) THEN 'Salé'
        WHEN (SELECT ST_Contains(geom, geometry) FROM poly_temara) THEN 'Témara'
        ELSE (SELECT city FROM centroids ORDER BY ST_Distance(c, geometry) LIMIT 1)
      END AS city
    FROM ov_raw
  `);
  fs.writeFileSync(OUT_FILE, jstr(rows));
  console.log('overture admin:', rows.length, 'fiches ->', OUT_FILE);
})().catch((e) => { console.error('ERREUR overture admin:', e.message); process.exit(1); });
