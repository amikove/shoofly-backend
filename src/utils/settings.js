// ── Lecture des paramètres configurables (table `settings`) avec cache mémoire ──
// Évite une requête DB à chaque appel pour des valeurs qui changent rarement
// (délais, seuils...). TTL court (60s) pour que les changements faits depuis
// l'admin soient pris en compte rapidement même sans appel à invalidateSettingsCache().
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // key -> { value: string, expiresAt: number }

function isNumeric(str) {
  return str !== '' && !isNaN(str);
}

async function getSetting(db, key, defaultValue) {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return isNumeric(cached.value) ? Number(cached.value) : cached.value;
  }

  const { rows } = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
  if (rows.length === 0) {
    return defaultValue;
  }

  const value = rows[0].value;
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return isNumeric(value) ? Number(value) : value;
}

function invalidateSettingsCache() {
  cache.clear();
}

module.exports = { getSetting, invalidateSettingsCache };
