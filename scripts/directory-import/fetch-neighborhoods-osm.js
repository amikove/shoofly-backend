// Étape "quartiers" : récupère les quartiers OSM (place=suburb|quarter|neighbourhood) dans la bbox
// RST via Overpass API — 100% automatique (décision BOSS #4, 2026-09-30), aucune saisie manuelle.
// Écrit out/osm_neighborhoods.json. Utilise `out center` pour les voies (way) : approximation
// centroïde, pas le polygone complet (voir RAPPORT_PHASE2_DONNEES.md pour la justification —
// le rattachement se fait ensuite par plus-proche-voisin, pas par point-in-polygon strict).
//
// Phase 5 sexies (2026-10-02), décision BOSS : run Render n°3, Overpass a échoué ("fetch failed"),
// ce qui faisait échouer tout le domaine santé (aucune retentative, aucun miroir de secours). Utilise
// désormais overpass-client.js (retries + miroirs officiels + diagnostic détaillé — voir ce fichier).
// DÉGRADATION PROPRE si tous les miroirs échouent : écrit out/osm_neighborhoods.json = [] (jamais
// une exception qui ferait échouer tout le domaine) + un fichier sentinelle
// out/osm_neighborhoods_unavailable.flag, qu'assign-neighborhoods.js détecte pour basculer sur le
// gazetteer de quartiers DÉJÀ EN BASE (table directory_neighborhoods) au lieu d'échouer.

const fs = require('fs');
const path = require('path');
const { fetchOverpass } = require('./overpass-client');

const LON_MIN = -6.98, LON_MAX = -6.70, LAT_MIN = 33.85, LAT_MAX = 34.12;
const OUT_FILE = path.join(__dirname, 'out', 'osm_neighborhoods.json');
const UNAVAILABLE_FLAG = path.join(__dirname, 'out', 'osm_neighborhoods_unavailable.flag');

async function main() {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  try { fs.unlinkSync(UNAVAILABLE_FLAG); } catch {} // run précédent éventuel : repartir propre

  const query = `;(` +
    `node["place"~"suburb|quarter|neighbourhood"](${LAT_MIN},${LON_MIN},${LAT_MAX},${LON_MAX});` +
    `way["place"~"suburb|quarter|neighbourhood"](${LAT_MIN},${LON_MIN},${LAT_MAX},${LON_MAX});` +
    `);out center tags;`;

  const data = await fetchOverpass(query);
  if (!data) {
    console.error('Overpass indisponible (tous miroirs épuisés) — dégradation : out/osm_neighborhoods.json = [], gazetteer DB utilisé en repli par assign-neighborhoods.js.');
    fs.writeFileSync(OUT_FILE, '[]');
    fs.writeFileSync(UNAVAILABLE_FLAG, new Date().toISOString());
    return; // succès (code 0) volontaire : ne fait PAS échouer le domaine santé
  }

  const items = data.elements.map((el) => ({
    osm_type: el.type,
    osm_id: el.id,
    lat: el.type === 'node' ? el.lat : el.center.lat,
    lng: el.type === 'node' ? el.lon : el.center.lon,
    name: el.tags.name || null,
    name_fr: el.tags['name:fr'] || null,
    name_ar: el.tags['name:ar'] || null,
    name_ary: el.tags['name:ary'] || null, // darija (dialecte marocain), utile comme alias supplémentaire
    place: el.tags.place,
  })).filter((r) => r.name); // un point sans nom n'est pas exploitable comme quartier

  fs.writeFileSync(OUT_FILE, JSON.stringify(items, null, 2));
  console.log('Quartiers OSM récupérés :', items.length, '(', items.filter(r => r.osm_type === 'node').length, 'nœuds,', items.filter(r => r.osm_type === 'way').length, 'voies )');
  console.log('Avec name:fr :', items.filter(r => r.name_fr).length, '- Avec name:ar :', items.filter(r => r.name_ar).length);
}

if (require.main === module) main().catch(e => { console.error('ERREUR:', e.message); process.exit(1); });
module.exports = { main };
