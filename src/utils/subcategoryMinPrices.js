// ── Planchers tarifaires par sous-catégorie (table `subcategory_min_prices`) avec cache mémoire ──
//
// Même principe que `utils/settings.js` (getSetting / invalidateSettingsCache) : éviter une
// requête DB à chaque création de mission pour des valeurs qui changent rarement, TTL court
// (60 s) pour que les modifications faites depuis l'admin soient prises en compte vite même sans
// invalidation explicite, ET invalidation immédiate à l'écriture (PUT admin) pour zéro fenêtre
// de valeur périmée. Ici tout tient en UNE ligne de cache (la table entière, ~49 lignes) — pas
// une entrée par clé comme settings.
//
// Chantier « planchers tarifaires par sous-catégorie éditables » (2026-09-10) — remplace la table
// en dur `SUBCATEGORY_MIN_PRICES` + `getSubcategoryMinPrice` de `constants/missionCategories.js`
// (chantier D1). Source de vérité = la table ; ce module est le seul lecteur runtime.

const CACHE_TTL_MS = 60 * 1000;
let cache = null; // { map: { [subcategory]: number }, expiresAt: number } | null

// Sépare le libellé de groupe préfixé des sous-catégories « file d'attente »
// ('Consulats et visas — Consulat étranger') de la clé nue ('Consulat étranger') sur laquelle
// la table est indexée. Séparateur ' — ' = espace + tiret cadratin U+2014 + espace. No-op pour
// les 3 autres types (aucun libellé ne contient ce séparateur). Identique au parsing d'origine
// (D1) et à `getMinPrice` côté frontend (NewMissionModal.jsx).
function bareSubcategory(subcategory) {
  return String(subcategory).split(' — ').pop();
}

async function loadMap(db) {
  if (cache && cache.expiresAt > Date.now()) return cache.map;
  const { rows } = await db.query('SELECT subcategory, min_price FROM subcategory_min_prices');
  const map = {};
  for (const r of rows) map[r.subcategory] = Number(r.min_price);
  cache = { map, expiresAt: Date.now() + CACHE_TTL_MS };
  return map;
}

function invalidateSubcategoryMinPricesCache() {
  cache = null;
}

// Plancher spécifique applicable à (type, subcategory), ou `null` si ni la sous-catégorie nommée
// ni le défaut par type ne sont en table (l'appelant retombe alors sur le plancher global
// `min_price`). Ordre de résolution — identique à `getMinPrice` frontend :
//   1. plancher de la sous-catégorie nommée (clé nue)
//   2. défaut par type ('_immobilier' / '_file_attente' / '_audit' / '_personnalisee')
//   3. null
// `body('type').isIn([...4 types])` (missionCreateValidators) garantit qu'un des 4 défauts par
// type est toujours présent en pratique → le `null` n'est qu'un garde-fou (type inattendu).
async function getSubcategoryMinPrice(db, type, subcategory) {
  const map = await loadMap(db);
  if (subcategory) {
    const bare = bareSubcategory(subcategory);
    if (Object.prototype.hasOwnProperty.call(map, bare)) return map[bare];
  }
  const typeKey = `_${type}`;
  if (Object.prototype.hasOwnProperty.call(map, typeKey)) return map[typeKey];
  return null;
}

module.exports = {
  getSubcategoryMinPrice,
  invalidateSubcategoryMinPricesCache,
  loadSubcategoryMinPricesMap: loadMap,
  bareSubcategory,
};
