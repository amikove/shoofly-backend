// Administrations — Foursquare, étape 1/2 (lecture HF seule, sans spatial — voir le commentaire de
// fetch-foursquare-raw.child.js pour l'explication du crash évité par cette séparation).
const fs = require('fs');
const duckdb = require('duckdb');

const FSQ_RELEASE_DT = '2026-09-15';
const LON_MIN = -6.98, LON_MAX = -6.70, LAT_MIN = 33.85, LAT_MAX = 34.12;
const OUT_FILE = process.argv[2];
const HF_ENV_PATH = process.argv[3];
function jstr(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? Number(v) : v, 2); }

function readHfToken() {
  const content = fs.readFileSync(HF_ENV_PATH, 'utf8');
  const m = content.match(/^HF_TOKEN\s*=\s*(.+)$/m);
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

(async () => {
  const token = readHfToken();
  if (!token) { console.error('ERREUR: HF_TOKEN introuvable'); process.exit(2); }
  const db = new duckdb.Database(':memory:');
  const con = db.connect();
  const run = (sql) => new Promise((resolve, reject) => con.all(sql, (err, rows) => err ? reject(err) : resolve(rows)));

  await run('INSTALL httpfs; LOAD httpfs;');
  await run(`CREATE SECRET hf_token (TYPE huggingface, TOKEN '${token}');`);
  const rows = await run(`
    SELECT fsq_place_id AS source_id, name, latitude AS lat, longitude AS lng, address, tel AS phone, website, fsq_category_labels
    FROM read_parquet('hf://datasets/foursquare/fsq-os-places/release/dt=${FSQ_RELEASE_DT}/places/parquet/*.parquet')
    WHERE country='MA' AND latitude BETWEEN ${LAT_MIN} AND ${LAT_MAX} AND longitude BETWEEN ${LON_MIN} AND ${LON_MAX}
      AND len(list_filter(fsq_category_labels, x -> x LIKE 'Community and Government%' OR x LIKE '%Bank%' OR x LIKE '%Financial%')) > 0
  `);
  fs.writeFileSync(OUT_FILE, jstr(rows));
  console.log('foursquare admin (brut, sans ville):', rows.length, 'fiches ->', OUT_FILE);
})().catch((e) => { console.error('ERREUR foursquare admin raw:', e.message); process.exit(1); });
