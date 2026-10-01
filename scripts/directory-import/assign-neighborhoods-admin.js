// Administrations — quartier : utilise le quartier FR/AR FOURNI DIRECTEMENT par MTNRA (décision
// BOSS Phase 2 bis #2 : "utilise le nom AR et le quartier FR/AR fournis par MTNRA quand ils
// existent (source officielle, pas une translittération)") — pas de plus-proche-voisin OSM ici,
// contrairement à la santé (§B.3 du rapport Phase 2), puisque MTNRA donne déjà cette information.
//
// Le quartier MTNRA est d'abord recherché EXACTEMENT (même slug) dans le gazetteer OSM déjà
// construit pour la santé (assign-neighborhoods.js, out/neighborhoods.json). Sinon (Phase 3,
// décision #3) : fusion AUTOMATIQUE par nom normalisé PROCHE (similarité Levenshtein) + distance,
// contre TOUT quartier déjà connu (OSM d'origine OU déjà créé par MTNRA plus tôt dans ce même run)
// dans la même ville — pour éviter de créer "Hay Riad"/"Hay Ryad"/"Riad" comme 3 entrées séparées.
// Seulement en dernier recours, une nouvelle entrée est créée, source='mtnra_provided'.

const fs = require('fs');
const path = require('path');
const { normalizeCore } = require('./keyword-rules');

const OUT_DIR = path.join(__dirname, 'out');
const FUZZY_SIMILARITY_MIN = 0.75; // 1 - distance/maxLen ; "Hay Riad" vs "Hay Ryad" ≈ 0.89
const FUZZY_DISTANCE_MAX_M = 1500; // échelle quartier, pas établissement (voir CORROBORATION_DISTANCE_M=100 des établissements)

function slugify(s) { return normalizeCore(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}
function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findFuzzyMatch(city, nameFr, lat, lng, candidatesByCity) {
  const candidates = candidatesByCity.get(city) || [];
  const normName = normalizeCore(nameFr);
  let best = null, bestScore = 0;
  for (const nb of candidates) {
    const score = similarity(normName, normalizeCore(nb.name_fr));
    if (score < FUZZY_SIMILARITY_MIN) continue;
    if (lat != null && nb.centroid_lat != null) {
      const d = haversineMeters(lat, lng, nb.centroid_lat, nb.centroid_lng);
      if (d > FUZZY_DISTANCE_MAX_M) continue;
    }
    if (score > bestScore) { bestScore = score; best = nb; }
  }
  return best ? { nb: best, score: bestScore } : null;
}

function main() {
  const merged = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'merged_admin.json'), 'utf8'));
  const existingNeighborhoods = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'neighborhoods.json'), 'utf8'));

  const byKey = new Map(existingNeighborhoods.map((nb) => [`${slugify(nb.city)}|${slugify(nb.name_fr)}`, nb]));
  const byCity = new Map();
  for (const nb of existingNeighborhoods) {
    if (!byCity.has(nb.city)) byCity.set(nb.city, []);
    byCity.get(nb.city).push(nb);
  }

  const newNeighborhoods = [];
  let matchedExact = 0, matchedFuzzy = 0, createdNew = 0, none = 0;

  for (const rec of merged) {
    if (!rec.quartier_fr || !rec.city) { rec.neighborhood_id = null; none++; continue; }
    const key = `${slugify(rec.city)}|${slugify(rec.quartier_fr)}`;
    let nb = byKey.get(key);
    if (nb) { matchedExact++; rec.neighborhood_id = nb.id; continue; }

    const fuzzy = findFuzzyMatch(rec.city, rec.quartier_fr, rec.lat, rec.lng, byCity);
    if (fuzzy) {
      matchedFuzzy++;
      byKey.set(key, fuzzy.nb); // mémorise cette variante de nom pour les prochaines fiches identiques
      rec.neighborhood_id = fuzzy.nb.id;
      continue;
    }

    nb = {
      id: `${slugify(rec.city)}-mtnra-${slugify(rec.quartier_fr)}`,
      city: rec.city, name_fr: rec.quartier_fr, name_ar: rec.quartier_ar || null,
      osm_type: null, osm_id: null,
      centroid_lat: rec.lat || null, centroid_lng: rec.lng || null,
      source: 'mtnra_provided',
    };
    byKey.set(key, nb);
    if (!byCity.has(rec.city)) byCity.set(rec.city, []);
    byCity.get(rec.city).push(nb); // visible pour la fuzzy-match des fiches suivantes dans ce run
    newNeighborhoods.push(nb);
    createdNew++;
    rec.neighborhood_id = nb.id;
  }

  fs.writeFileSync(path.join(OUT_DIR, 'merged_admin.json'), JSON.stringify(merged, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'neighborhoods_admin_new.json'), JSON.stringify(newNeighborhoods, null, 2));

  console.log('Quartiers MTNRA -> correspondance EXACTE gazetteer OSM :', matchedExact);
  console.log('Quartiers MTNRA -> correspondance FLOUE (nom proche + distance) :', matchedFuzzy);
  console.log('Nouveaux quartiers créés (source mtnra_provided) :', createdNew);
  console.log('Sans quartier (absent chez MTNRA ou ville inconnue) :', none);
  console.log('Taux de rattachement administrations :', (merged.length - none), '/', merged.length,
    `(${((100 * (merged.length - none)) / merged.length).toFixed(1)}%)`);
}

if (require.main === module) main();
module.exports = { main, levenshtein, similarity };
