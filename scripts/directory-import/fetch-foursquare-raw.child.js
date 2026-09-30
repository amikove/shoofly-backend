// Process isolé, étape 1/2 pour Foursquare : lecture HF SEULE, AUCUNE extension spatiale chargée
// dans ce process. Nécessaire : charger httpfs+spatial+secret HF ensemble dans le même process a
// provoqué un Segmentation Fault reproductible (testé 2026-09-30) lors de la lecture du parquet HF
// avec un filtre list_filter — comportement de même famille que le crash DuckDB S3+spatial déjà
// documenté dans seo-study/07_main_analysis.js (fusion scan+jointure spatiale interdite dans une
// même requête). Ici on va plus loin : même charger les DEUX extensions dans le même PROCESS crashait,
// pas seulement la même requête. La jointure ville est donc faite dans un 3e process séparé
// (fetch-foursquare-city.child.js) à partir du JSON écrit ici (lat/lon bruts, pas de géométrie).
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
    SELECT fsq_place_id AS source_id, name, latitude AS lat, longitude AS lng, address,
           tel AS phone, website, date_closed, date_refreshed, fsq_category_labels
    FROM read_parquet('hf://datasets/foursquare/fsq-os-places/release/dt=${FSQ_RELEASE_DT}/places/parquet/*.parquet')
    WHERE country='MA' AND latitude BETWEEN ${LAT_MIN} AND ${LAT_MAX} AND longitude BETWEEN ${LON_MIN} AND ${LON_MAX}
      AND len(list_filter(fsq_category_labels, x -> x LIKE 'Health and Medicine%')) > 0
      AND NOT list_contains(fsq_category_labels, 'Health and Medicine > Veterinarian')
  `);
  fs.writeFileSync(OUT_FILE, jstr(rows));
  console.log('foursquare (brut, sans ville):', rows.length, 'fiches ->', OUT_FILE);
})().catch(e => { console.error('ERREUR foursquare raw:', e.message); process.exit(1); });
