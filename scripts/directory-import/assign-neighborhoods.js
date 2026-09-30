// Étape 3 : rattachement quartier 100% automatique (décision BOSS #4, 2026-09-30) — deux signaux :
//   (a) détection du nom du quartier dans l'adresse de la fiche (texte direct, source = la fiche
//       elle-même) ;
//   (b) plus-proche-voisin géométrique contre les points OSM récupérés par Overpass (out center :
//       centroïde pour les voies, position exacte pour les nœuds — pas de point-in-polygon strict,
//       voir le commentaire de fetch-neighborhoods-osm.js).
//
// Règle de décision quand les deux divergent (demandée explicitement par la décision #4) :
//   - un texte d'adresse qui nomme un quartier est un signal plus direct qu'une estimation
//     géométrique par plus-proche-voisin (qui peut se tromper près d'une frontière de quartier,
//     ou quand aucun point OSM proche n'existe réellement) ;
//   - MAIS un mot qui apparaît par coïncidence dans une adresse (faux positif) est possible :
//     on n'accepte le signal "adresse" que s'il reste géométriquement plausible, c.-à-d. si LE
//     POINT OSM CORRESPONDANT à ce nom est à moins de 3 km de la fiche.
//   => Priorité : (1) détection adresse validée géométriquement (< 3 km du point OSM du même nom),
//      (2) sinon plus-proche-voisin si < 1.2 km, (3) sinon aucun quartier (la fiche reste au niveau
//      ville uniquement — cohérent avec le seuil ≥3 fiches qui de toute façon exclurait un quartier
//      quasi-vide).
//
// Dédoublonnage du gazetteer OSM lui-même (PAS des fiches établissements — décision #1/#2
// inchangées) : deux points OSM de même nom normalisé à moins de 500 m sont fusionnés en une seule
// entrée quartier (ex. 'Harhoura Centre' apparaît 2x dans Overpass, 'Oulad Mtaa' aussi).

const fs = require('fs');
const path = require('path');
const { normalizeCore } = require('./keyword-rules');

const OUT_DIR = path.join(__dirname, 'out');
const DATA_DIR = path.join(__dirname, 'data');
const ADDRESS_VALIDATION_RADIUS_M = 3000;
const NEAREST_POINT_RADIUS_M = 1200;
const DEDUP_RADIUS_M = 500;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Point-in-polygon (ray casting), simple GeoJSON Polygon/MultiPolygon — uniquement pour classer
// les ~61 points OSM par ville (pas les fiches établissements, déjà classées en amont par DuckDB
// ST_Contains, plus rigoureux). Suffisant ici : peu de points, pas de cas limite critique.
function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const intersect = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointInGeoJson(lat, lng, geojson) {
  const geom = geojson.features ? geojson.features[0].geometry : geojson.geometry || geojson;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  for (const poly of polys) if (pointInRing(lat, lng, poly[0])) return true;
  return false;
}

function slugify(s) {
  return normalizeCore(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function loadCityPolygons() {
  return {
    Rabat: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'boundary_rabat.geojson'), 'utf8')),
    Salé: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'boundary_sale.geojson'), 'utf8')),
    Témara: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'boundary_temara.geojson'), 'utf8')),
  };
}

function assignCityToPoint(lat, lng, polygons) {
  for (const [city, geojson] of Object.entries(polygons)) if (pointInGeoJson(lat, lng, geojson)) return city;
  return null; // un quartier OSM hors des 3 polygones (rare) reste sans ville — ignoré
}

function buildNeighborhoodGazetteer(osmRaw, polygons) {
  const withCity = osmRaw.map((r) => ({ ...r, city: assignCityToPoint(r.lat, r.lng, polygons) })).filter((r) => r.city);
  const groups = [];
  for (const r of withCity) {
    const key = slugify(r.name_fr || r.name);
    let group = groups.find((g) => g.key === key && g.city === r.city && haversineMeters(g.lat, g.lng, r.lat, r.lng) < DEDUP_RADIUS_M);
    if (!group) { group = { key, city: r.city, lat: r.lat, lng: r.lng, members: [] }; groups.push(group); }
    group.members.push(r);
  }
  return groups.map((g) => {
    const primary = g.members[0];
    return {
      id: `${slugify(g.city)}-${g.key}`,
      city: g.city,
      name_fr: primary.name_fr || primary.name,
      name_ar: primary.name_ar || null,
      osm_type: primary.osm_type,
      osm_id: primary.osm_id,
      centroid_lat: g.lat,
      centroid_lng: g.lng,
      source: 'osm_overpass',
      // alias utilisés pour la détection dans l'adresse (nom FR, nom brut multi-script, darija AR).
      aliases: [...new Set(g.members.flatMap((m) => [m.name_fr, m.name, m.name_ary]).filter(Boolean))],
    };
  });
}

function findAddressMatch(address, neighborhoods) {
  if (!address) return null;
  const normAddr = ' ' + normalizeCore(address) + ' ';
  for (const nb of neighborhoods) {
    for (const alias of nb.aliases) {
      // un alias contenant plusieurs scripts (ex. "Aviation ⴰⵠⵢⴰⵙⵢⵓⵏ الطيران") est découpé par
      // script — un seul composant doit matcher, pas la chaîne brute complète.
      const parts = alias.split(/\s+/).filter((p) => normalizeCore(p).length >= 3);
      for (const part of parts) {
        const norm = normalizeCore(part);
        if (norm.length >= 3 && normAddr.includes(' ' + norm + ' ')) return nb;
      }
    }
  }
  return null;
}

function assignNeighborhood(establishment, neighborhoodsByCity) {
  const candidates = neighborhoodsByCity[establishment.city] || [];
  if (candidates.length === 0) return { neighborhood_id: null, method: 'no_candidates_for_city' };

  let nearest = null, nearestDist = Infinity;
  for (const nb of candidates) {
    const d = haversineMeters(establishment.lat, establishment.lng, nb.centroid_lat, nb.centroid_lng);
    if (d < nearestDist) { nearestDist = d; nearest = nb; }
  }

  const addressMatch = findAddressMatch(establishment.address, candidates);
  if (addressMatch) {
    const distToMatch = haversineMeters(establishment.lat, establishment.lng, addressMatch.centroid_lat, addressMatch.centroid_lng);
    if (distToMatch < ADDRESS_VALIDATION_RADIUS_M) {
      const divergent = nearest && nearest.id !== addressMatch.id && nearestDist < NEAREST_POINT_RADIUS_M;
      return { neighborhood_id: addressMatch.id, method: divergent ? 'address_text_over_nearest' : 'address_text', divergent };
    }
  }
  if (nearest && nearestDist <= NEAREST_POINT_RADIUS_M) return { neighborhood_id: nearest.id, method: 'nearest_point' };
  return { neighborhood_id: null, method: 'none' };
}

function main() {
  const merged = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'merged.json'), 'utf8'));
  const osmRaw = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'osm_neighborhoods.json'), 'utf8'));
  const polygons = loadCityPolygons();

  const gazetteer = buildNeighborhoodGazetteer(osmRaw, polygons);
  const byCity = {};
  for (const nb of gazetteer) (byCity[nb.city] = byCity[nb.city] || []).push(nb);

  let divergentCount = 0;
  for (const rec of merged) {
    const result = assignNeighborhood(rec, byCity);
    rec.neighborhood_id = result.neighborhood_id;
    rec.neighborhood_method = result.method;
    if (result.divergent) divergentCount++;
  }

  fs.writeFileSync(path.join(OUT_DIR, 'neighborhoods.json'), JSON.stringify(gazetteer, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'merged.json'), JSON.stringify(merged, null, 2));

  const attached = merged.filter((r) => r.neighborhood_id).length;
  console.log('Gazetteer quartiers (après dédoublonnage OSM) :', gazetteer.length, 'sur', osmRaw.length, 'points OSM bruts');
  console.log('Par ville :', JSON.stringify(Object.fromEntries(Object.entries(byCity).map(([c, l]) => [c, l.length]))));
  console.log('Fiches rattachées à un quartier :', attached, '/', merged.length, '(' + ((100 * attached) / merged.length).toFixed(1) + '%)');
  console.log('Méthode :', JSON.stringify(merged.reduce((a, r) => { a[r.neighborhood_method] = (a[r.neighborhood_method] || 0) + 1; return a; }, {})));
  console.log('Divergences adresse/géométrie résolues en faveur du texte adresse :', divergentCount);
}

if (require.main === module) main();
module.exports = { main, haversineMeters, assignNeighborhood, buildNeighborhoodGazetteer };
