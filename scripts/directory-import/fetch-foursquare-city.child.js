// Process isolé, étape 2/2 pour Foursquare : jointure ville SEULE (spatial, pas de HF/httpfs),
// à partir du JSON écrit par fetch-foursquare-raw.child.js (lat/lng bruts). Voir le commentaire
// de ce dernier pour l'explication de cette séparation en 2 process.
const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');

const DATA_DIR = path.join(__dirname, 'data').replace(/\\/g, '/');
const IN_FILE = process.argv[2];
const OUT_FILE = process.argv[3];
function jstr(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? Number(v) : v, 2); }

(async () => {
  const db = new duckdb.Database(':memory:');
  const con = db.connect();
  const run = (sql) => new Promise((resolve, reject) => con.all(sql, (err, rows) => err ? reject(err) : resolve(rows)));

  await run('INSTALL spatial; LOAD spatial;');
  await run(`CREATE TABLE poly_rabat AS SELECT geom FROM ST_Read('${DATA_DIR}/boundary_rabat.geojson')`);
  await run(`CREATE TABLE poly_sale AS SELECT geom FROM ST_Read('${DATA_DIR}/boundary_sale.geojson')`);
  await run(`CREATE TABLE poly_temara AS SELECT geom FROM ST_Read('${DATA_DIR}/boundary_temara.geojson')`);
  await run(`CREATE TABLE centroids AS
    SELECT 'Rabat' AS city, ST_Centroid(geom) AS c FROM poly_rabat
    UNION ALL SELECT 'Salé', ST_Centroid(geom) FROM poly_sale
    UNION ALL SELECT 'Témara', ST_Centroid(geom) FROM poly_temara`);
  await run(`CREATE TABLE fsq_raw AS SELECT * FROM read_json_auto('${IN_FILE.replace(/\\/g, '/')}')`);

  const rows = await run(`
    SELECT *,
      CASE
        WHEN (SELECT ST_Contains(geom, ST_Point(lng, lat)) FROM poly_rabat) THEN 'Rabat'
        WHEN (SELECT ST_Contains(geom, ST_Point(lng, lat)) FROM poly_sale) THEN 'Salé'
        WHEN (SELECT ST_Contains(geom, ST_Point(lng, lat)) FROM poly_temara) THEN 'Témara'
        ELSE (SELECT city FROM centroids ORDER BY ST_Distance(c, ST_Point(lng, lat)) LIMIT 1)
      END AS city
    FROM fsq_raw
  `);
  fs.writeFileSync(OUT_FILE, jstr(rows));
  console.log('foursquare (avec ville):', rows.length, 'fiches ->', OUT_FILE);
})().catch(e => { console.error('ERREUR foursquare city:', e.message); process.exit(1); });
