// Administrations — Foursquare, étape 1/2 (lecture HF seule, sans spatial — voir le commentaire de
// fetch-foursquare-raw.child.js pour l'explication du crash évité par cette séparation).
const fs = require('fs');
const duckdb = require('duckdb');

const FSQ_RELEASE_DT = '2026-09-15';
const LON_MIN = -6.98, LON_MAX = -6.70, LAT_MIN = 33.85, LAT_MAX = 34.12;
const OUT_FILE = process.argv[2];
const HF_ENV_PATH = process.argv[3];
function jstr(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? Number(v) : v, 2); }

// Phase 5 quater (2026-10-01) — en production (Cron Render), HF_TOKEN est une variable
// d'environnement du service, pas un fichier (seo-study/ n'existe pas sur Render, hors du dépôt).
// On privilégie donc process.env.HF_TOKEN ; le fichier local (dev uniquement) reste un repli si la
// variable d'environnement est absente.
//
// Phase 5 quinquies (2026-10-01) — bug trouvé : 401 Unauthorized sur hf:// malgré HF_TOKEN défini
// sur Render. execFileSync transmet bien process.env.HF_TOKEN tel quel aux process enfants (vérifié
// empiriquement, 2 niveaux d'imbrication comme en prod) — ce n'est PAS un problème de propagation.
// Le vrai bug : seul le chemin "lu depuis le fichier" nettoyait la valeur (trim + guillemets) ;
// process.env.HF_TOKEN était utilisé BRUT. Une valeur collée dans le dashboard Render avec un espace
// ou un retour à la ligne de trop (ou des guillemets autour) produisait un jeton invalide passé tel
// quel à CREATE SECRET — explique le 401 sans erreur de lecture. Les deux sources sont maintenant
// nettoyées de façon identique, et un log de diagnostic (JAMAIS la valeur elle-même) précède l'essai.
function cleanToken(raw) {
  return raw.trim().replace(/^['"]+|['"]+$/g, '').trim();
}
function logTokenDiagnostics(raw, source) {
  if (!raw) { console.log(`[HF_TOKEN diagnostic] absent (source tentée : ${source})`); return; }
  console.log(`[HF_TOKEN diagnostic] source=${source} longueur=${raw.length} prefixe_hf_=${raw.trim().replace(/^['"]+/, '').startsWith('hf_') ? 'oui' : 'non'} espaces_parasites=${raw !== raw.trim() ? 'oui' : 'non'} guillemets_parasites=${/^['"]|['"]$/.test(raw.trim()) ? 'oui' : 'non'}`);
}
function readHfToken() {
  let raw, source;
  if (process.env.HF_TOKEN) {
    raw = process.env.HF_TOKEN;
    source = "variable d'environnement";
  } else if (HF_ENV_PATH && fs.existsSync(HF_ENV_PATH)) {
    const content = fs.readFileSync(HF_ENV_PATH, 'utf8');
    const m = content.match(/^HF_TOKEN\s*=\s*(.+)$/m);
    raw = m ? m[1] : null;
    source = `fichier ${HF_ENV_PATH}`;
  } else {
    raw = null;
    source = 'aucune (ni variable, ni fichier)';
  }
  logTokenDiagnostics(raw, source);
  return raw ? cleanToken(raw) : null;
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
