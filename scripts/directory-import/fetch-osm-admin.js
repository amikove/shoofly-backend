// Administrations — OSM/Overpass, AVEC coordonnées (contrairement à l'étude Phase 2 §E qui ne
// gardait que nom+type pour compter). Nécessaire ici pour le recoupement par distance avec MTNRA.
const fs = require('fs');
const path = require('path');

const LON_MIN = -6.98, LON_MAX = -6.70, LAT_MIN = 33.85, LAT_MAX = 34.12;
const OUT_FILE = path.join(__dirname, 'out', 'osm_admin.json');
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

async function main() {
  const query = `[out:json][timeout:60];(` +
    `node["amenity"~"townhall|police|courthouse|post_office|bank"](${LAT_MIN},${LON_MIN},${LAT_MAX},${LON_MAX});` +
    `way["amenity"~"townhall|police|courthouse|post_office|bank"](${LAT_MIN},${LON_MIN},${LAT_MAX},${LON_MAX});` +
    `node["office"="government"](${LAT_MIN},${LON_MIN},${LAT_MAX},${LON_MAX});` +
    `way["office"="government"](${LAT_MIN},${LON_MIN},${LAT_MAX},${LON_MAX});` +
    `);out center tags;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'shoofly-directory-import/1.0 (contact: amikove@gmail.com)' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();
  const items = data.elements.map((el) => ({
    source_id: `${el.type}/${el.id}`,
    name: el.tags.name || null,
    lat: el.type === 'node' ? el.lat : el.center.lat,
    lng: el.type === 'node' ? el.lon : el.center.lon,
    amenity: el.tags.amenity || el.tags.office || null,
    phone: el.tags.phone || el.tags['contact:phone'] || null,
  })).filter((r) => r.name);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(items, null, 2));
  console.log('OSM admin (avec coordonnées) :', items.length, 'éléments nommés');
}

if (require.main === module) main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
module.exports = { main };
