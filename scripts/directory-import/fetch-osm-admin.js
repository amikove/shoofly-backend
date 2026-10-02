// Administrations — OSM/Overpass, AVEC coordonnées (contrairement à l'étude Phase 2 §E qui ne
// gardait que nom+type pour compter). Nécessaire ici pour le recoupement par distance avec MTNRA.
//
// Phase 5 sexies (2026-10-02), décision BOSS : run Render n°3, Overpass a échoué ("fetch failed"),
// ce qui faisait échouer tout le domaine administrations. Utilise désormais overpass-client.js
// (retries + miroirs officiels + diagnostic détaillé — voir ce fichier). DÉGRADATION PROPRE si tous
// les miroirs échouent : écrit out/osm_admin.json = [] (jamais une exception) + un fichier
// sentinelle out/osm_admin_unavailable.flag, que run-import-admin.js détecte pour EXCLURE les
// fiches dont primary_source='osm_overpass' (les banques trouvées UNIQUEMENT par OSM, jamais côté
// MTNRA/Foursquare — voir merge-classify-admin.js §3) de la détection "disparue" : une source
// indisponible ce mois-ci ne doit jamais faire passer ses fiches en pending_review.
const fs = require('fs');
const path = require('path');
const { fetchOverpass } = require('./overpass-client');

const LON_MIN = -6.98, LON_MAX = -6.70, LAT_MIN = 33.85, LAT_MAX = 34.12;
const OUT_FILE = path.join(__dirname, 'out', 'osm_admin.json');
const UNAVAILABLE_FLAG = path.join(__dirname, 'out', 'osm_admin_unavailable.flag');

async function main() {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  try { fs.unlinkSync(UNAVAILABLE_FLAG); } catch {} // run précédent éventuel : repartir propre

  const query = `;(` +
    `node["amenity"~"townhall|police|courthouse|post_office|bank"](${LAT_MIN},${LON_MIN},${LAT_MAX},${LON_MAX});` +
    `way["amenity"~"townhall|police|courthouse|post_office|bank"](${LAT_MIN},${LON_MIN},${LAT_MAX},${LON_MAX});` +
    `node["office"="government"](${LAT_MIN},${LON_MIN},${LAT_MAX},${LON_MAX});` +
    `way["office"="government"](${LAT_MIN},${LON_MIN},${LAT_MAX},${LON_MAX});` +
    `);out center tags;`;

  const data = await fetchOverpass(query);
  if (!data) {
    console.error('Overpass indisponible (tous miroirs épuisés) — dégradation : out/osm_admin.json = [], administrations importées sans recoupement OSM ce run.');
    fs.writeFileSync(OUT_FILE, '[]');
    fs.writeFileSync(UNAVAILABLE_FLAG, new Date().toISOString());
    return; // succès (code 0) volontaire : ne fait PAS échouer le domaine administrations
  }

  const items = data.elements.map((el) => ({
    source_id: `${el.type}/${el.id}`,
    name: el.tags.name || null,
    lat: el.type === 'node' ? el.lat : el.center.lat,
    lng: el.type === 'node' ? el.lon : el.center.lon,
    amenity: el.tags.amenity || el.tags.office || null,
    phone: el.tags.phone || el.tags['contact:phone'] || null,
  })).filter((r) => r.name);
  fs.writeFileSync(OUT_FILE, JSON.stringify(items, null, 2));
  console.log('OSM admin (avec coordonnées) :', items.length, 'éléments nommés');
}

if (require.main === module) main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
module.exports = { main };
