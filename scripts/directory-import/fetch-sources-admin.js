// Administrations — étape 1 : récupère les établissements RST (banques, administrations) depuis
// Overture Maps, Foursquare OS Places et OSM/Overpass, pour recoupement avec MTNRA dans
// merge-classify-admin.js. Miroir de fetch-sources.js (santé) : mêmes précautions (chaque source
// dans un process Node séparé, voir leurs .child.js respectifs — httpfs+spatial dans le même
// process DuckDB a provoqué un Segmentation Fault reproductible).
//
// Phase 5 bis (2026-09-30), décision BOSS #1 : cette orchestration n'existait pas — merge-classify-
// admin.js attendait out/overture_admin.json, out/foursquare_admin.json et out/osm_admin.json sans
// qu'aucune étape automatisée ne les produise (générés manuellement lors de la Phase 2 bis). Câblée
// ici dans le bon ordre et wirée dans run-monthly-import.js.
//
// fetch-foursquare-city.child.js est RÉUTILISÉ tel quel (déjà générique : IN_FILE/OUT_FILE en
// arguments, aucune logique spécifique au domaine santé).
//
// Usage : node fetch-sources-admin.js → écrit out/overture_admin.json, out/foursquare_admin.json,
// out/osm_admin.json. Nécessite HF_TOKEN dans seo-study/.env (même variable que la santé) et les
// limites de ville (data/boundary_*.geojson — voir fetch-boundaries-nominatim.js, appelé avant
// cette étape par run-monthly-import.js).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT_DIR = path.join(__dirname, 'out');
const HF_ENV_PATH = path.join(__dirname, '..', '..', '..', 'seo-study', '.env');

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Phase 5 quater (2026-10-01) : seo-study/ n'existe pas sur Render (hors du dépôt) — HF_TOKEN y
  // est fourni en variable d'environnement du service, jamais via ce fichier.
  if (!process.env.HF_TOKEN && !fs.existsSync(HF_ENV_PATH)) {
    console.error('ARRÊT : HF_TOKEN absent (ni variable d\'environnement, ni seo-study/.env local) — requis pour Foursquare.');
    process.exit(2);
  }

  const overtureOut = path.join(OUT_DIR, 'overture_admin.json');
  const fsqRawOut = path.join(OUT_DIR, 'foursquare_admin_raw.json');
  const fsqOut = path.join(OUT_DIR, 'foursquare_admin.json');

  console.log('[1/4] Overture administrations (process isolé)...');
  execFileSync(process.execPath, [path.join(__dirname, 'fetch-overture-admin.child.js'), overtureOut], { stdio: 'inherit' });

  console.log('[2/4] Foursquare administrations — lecture HF (process isolé, sans spatial)...');
  execFileSync(process.execPath, [path.join(__dirname, 'fetch-foursquare-admin-raw.child.js'), fsqRawOut, HF_ENV_PATH], { stdio: 'inherit' });

  console.log('[3/4] Foursquare administrations — jointure ville (process isolé, sans HF)...');
  execFileSync(process.execPath, [path.join(__dirname, 'fetch-foursquare-city.child.js'), fsqRawOut, fsqOut], { stdio: 'inherit' });

  console.log('[4/4] OSM/Overpass administrations...');
  execFileSync(process.execPath, [path.join(__dirname, 'fetch-osm-admin.js')], { stdio: 'inherit' });

  const overture = JSON.parse(fs.readFileSync(overtureOut, 'utf8'));
  const fsq = JSON.parse(fs.readFileSync(fsqOut, 'utf8'));
  console.log('DONE.', overture.length, 'Overture +', fsq.length, 'Foursquare (administrations).');
}

if (require.main === module) main();
module.exports = { main };
