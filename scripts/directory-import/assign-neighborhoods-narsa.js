// NARSA CCT — quartier par plus-proche-voisin (même méthode que la santé, assign-neighborhoods.js
// §nearest_point), à partir du gazetteer DÉJÀ EN BASE (table directory_neighborhoods), PAS d'un
// fichier produit par le domaine santé (Phase 5 bis, 2026-09-30, décision BOSS #2) : un échec du
// domaine santé pendant CE run ne doit plus jamais empêcher NARSA de rattacher ses quartiers — le
// gazetteer existant (peuplé par les runs précédents, santé ou administrations) suffit très
// largement, les quartiers évoluent rarement d'un mois à l'autre. NARSA donne des coordonnées GPS
// réelles mais pas de champ quartier texte (contrairement à MTNRA) — pas de détection d'adresse
// possible non plus (l'adresse NARSA est en une seule ligne libre, souvent sans nom de quartier
// explicite).
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const OUT_DIR = path.join(__dirname, 'out');
const NEAREST_POINT_RADIUS_M = 1200;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function loadNeighborhoodsFromDb() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT id, city, centroid_lat, centroid_lng FROM directory_neighborhoods WHERE centroid_lat IS NOT NULL AND centroid_lng IS NOT NULL"
    );
    return rows.map((r) => ({ id: r.id, city: r.city, centroid_lat: Number(r.centroid_lat), centroid_lng: Number(r.centroid_lng) }));
  } finally {
    await client.end();
  }
}

async function main() {
  const narsa = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'narsa_cct.json'), 'utf8'));
  const neighborhoods = await loadNeighborhoodsFromDb();
  const byCity = {};
  for (const nb of neighborhoods) (byCity[nb.city] ||= []).push(nb);

  let attached = 0;
  for (const rec of narsa) {
    const candidates = byCity[rec.city] || [];
    let nearest = null, nearestDist = Infinity;
    for (const nb of candidates) {
      const d = haversineMeters(rec.lat, rec.lng, nb.centroid_lat, nb.centroid_lng);
      if (d < nearestDist) { nearestDist = d; nearest = nb; }
    }
    rec.neighborhood_id = (nearest && nearestDist <= NEAREST_POINT_RADIUS_M) ? nearest.id : null;
    if (rec.neighborhood_id) attached++;
  }

  fs.writeFileSync(path.join(OUT_DIR, 'narsa_cct.json'), JSON.stringify(narsa, null, 2));
  console.log('Quartiers en base disponibles :', neighborhoods.length);
  console.log('NARSA CCT rattachées à un quartier :', attached, '/', narsa.length);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERREUR assign-neighborhoods-narsa :', e.message); process.exit(1); });
}
module.exports = { main };
