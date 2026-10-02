// Client Overpass PARTAGÉ (domaines santé + administrations) — Phase 5 sexies (2026-10-02).
//
// Run Render n°3 : Overpass ("fetch failed") a fait échouer fetch-neighborhoods-osm.js (santé) et
// fetch-osm-admin.js (administrations), ce qui faisait échouer les DEUX domaines entiers (une seule
// requête, un seul miroir, aucune retentative). Ce module centralise la robustesse :
//   - plusieurs tentatives par miroir, timeout généreux (90s côté requête Overpass QL elle-même,
//     100s côté fetch — légèrement plus large pour laisser le serveur renvoyer sa propre erreur de
//     timeout proprement plutôt que de couper nous-mêmes en premier) ;
//   - repli sur d'autres instances Overpass PUBLIQUES OFFICIELLES si le miroir principal échoue —
//     liste prise sur https://wiki.openstreetmap.org/wiki/Overpass_API, section "Instances with
//     global data coverage" (lue le 2026-10-02), limitée aux miroirs SANS clé API (utilisables tels
//     quels) ET à couverture MONDIALE (les miroirs régionaux du wiki — Royaume-Uni/Irlande,
//     Richmond VA, Éthiopie — ne couvrent pas le Maroc, écartés) ;
//   - diagnostic réseau détaillé (même technique que NARSA : error.cause déroulé, jamais juste
//     "fetch failed") ;
//   - DÉGRADATION, jamais d'exception : si tous les miroirs échouent après leurs tentatives,
//     fetchOverpass() retourne `null` — à l'appelant (fetch-neighborhoods-osm.js / fetch-osm-
//     admin.js) de dégrader proprement plutôt que de faire échouer tout le domaine (décision BOSS).
const USER_AGENT = 'ShooflyDirectoryBot/1.0 (+https://shoofly.ma; contact: contact@shoofly.ma)';
const QUERY_TIMEOUT_S = 90;
const FETCH_TIMEOUT_MS = 100000;
const ATTEMPTS_PER_MIRROR = 2;
const RETRY_DELAY_MS = 3000;
const RATE_LIMIT_WAIT_MS = 30000; // politique d'usage officielle FOSSGIS (wiki OSM) : 30s avant nouvel essai sur 429/406

const { describeNetworkError } = require('./network-diagnostics');

const MIRRORS = [
  { name: 'FOSSGIS (principal)', url: 'https://overpass-api.de/api/interpreter' },
  { name: 'Private.coffee', url: 'https://overpass.private.coffee/api/interpreter' },
  { name: 'VK Maps', url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter' },
];

// queryBody : la requête Overpass QL SANS le préfixe [timeout:N] (ajouté ici, identique pour tous
// les miroirs). Retourne les données JSON parsées, ou `null` si tous les miroirs ont échoué.
async function fetchOverpass(queryBody) {
  const query = `[timeout:${QUERY_TIMEOUT_S}]${queryBody}`;
  for (const mirror of MIRRORS) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MIRROR; attempt++) {
      console.log(`Overpass — ${mirror.name}, tentative ${attempt}/${ATTEMPTS_PER_MIRROR}...`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(mirror.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: 'data=' + encodeURIComponent(query),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.status === 429 || res.status === 406) {
          console.warn(`Overpass — ${mirror.name} : HTTP ${res.status} (limite atteinte) — attente ${RATE_LIMIT_WAIT_MS / 1000}s avant nouvel essai...`);
          await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));
          continue;
        }
        if (!res.ok) {
          console.warn(`Overpass — ${mirror.name} : HTTP ${res.status} (tentative ${attempt}/${ATTEMPTS_PER_MIRROR})`);
          continue;
        }
        const data = await res.json();
        console.log(`Overpass — ${mirror.name} : OK (${data.elements ? data.elements.length : 0} éléments)`);
        return data;
      } catch (e) {
        clearTimeout(timer);
        const reason = e.name === 'AbortError' ? `délai dépassé (${FETCH_TIMEOUT_MS / 1000}s)` : e.message;
        console.warn(`Overpass — ${mirror.name} : échec réseau (tentative ${attempt}/${ATTEMPTS_PER_MIRROR}) — ${reason}`);
        console.warn(describeNetworkError(e));
        if (attempt < ATTEMPTS_PER_MIRROR) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  console.error(`Overpass — tous les miroirs (${MIRRORS.map((m) => m.name).join(', ')}) ont échoué après ${ATTEMPTS_PER_MIRROR} tentatives chacun.`);
  return null;
}

module.exports = { fetchOverpass, describeNetworkError, MIRRORS, USER_AGENT };
