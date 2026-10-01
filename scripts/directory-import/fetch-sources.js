// Étape 1 du pipeline : récupère TOUS les établissements santé RST depuis Overture Maps et
// Foursquare OS Places (lecture seule, aucune écriture DB ici). Décision BOSS #1 (2026-09-30) :
// AUCUNE fiche écartée — hôpitaux, radiologie, urgences et zone périphérique sont inclus comme le
// reste ; le tri qualité se fait à l'affichage (confiance), jamais à l'import. Zone périphérique
// rattachée automatiquement à la ville dont le centroïde est le plus proche (décision #3).
//
// Chaque source tourne dans un PROCESS NODE SÉPARÉ (voir les 3 fichiers .child.js) : charger
// httpfs (S3 ou Hugging Face) ET l'extension spatial dans le même process DuckDB a provoqué un
// Segmentation Fault reproductible pendant ce chantier (2026-09-30) — cette orchestration isole
// chaque étape à risque, chacune dans son propre process jetable.
//
// Usage : node fetch-sources.js  → écrit out/overture_health.json, out/foursquare_health.json,
// out/fetch_meta.json. Nécessite HF_TOKEN dans seo-study/.env (décision BOSS #9).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT_DIR = path.join(__dirname, 'out');
const HF_ENV_PATH = path.join(__dirname, '..', '..', '..', 'seo-study', '.env');

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(HF_ENV_PATH)) {
    console.error('ARRÊT : seo-study/.env introuvable — HF_TOKEN requis (décision BOSS #9).');
    process.exit(2);
  }

  const overtureOut = path.join(OUT_DIR, 'overture_health.json');
  const fsqRawOut = path.join(OUT_DIR, 'foursquare_health_raw.json');
  const fsqOut = path.join(OUT_DIR, 'foursquare_health.json');

  console.log('[1/3] Overture (process isolé)...');
  execFileSync(process.execPath, [path.join(__dirname, 'fetch-overture.child.js'), overtureOut], { stdio: 'inherit' });

  console.log('[2/3] Foursquare — lecture HF (process isolé, sans spatial)...');
  execFileSync(process.execPath, [path.join(__dirname, 'fetch-foursquare-raw.child.js'), fsqRawOut, HF_ENV_PATH], { stdio: 'inherit' });

  console.log('[3/3] Foursquare — jointure ville (process isolé, sans HF)...');
  execFileSync(process.execPath, [path.join(__dirname, 'fetch-foursquare-city.child.js'), fsqRawOut, fsqOut], { stdio: 'inherit' });

  const overture = JSON.parse(fs.readFileSync(overtureOut, 'utf8'));
  const fsq = JSON.parse(fs.readFileSync(fsqOut, 'utf8'));
  fs.writeFileSync(path.join(OUT_DIR, 'fetch_meta.json'), JSON.stringify({
    fetched_at: new Date().toISOString(),
    overture_release: '2026-09-23.0',
    foursquare_release: 'dt=2026-09-15',
    overture_count: overture.length,
    foursquare_count: fsq.length,
  }, null, 2));
  console.log('DONE.', overture.length, 'Overture +', fsq.length, 'Foursquare.');
}

if (require.main === module) main();
module.exports = { main };
