// Centres de visite technique — source NARSA (régulateur public), décision BOSS Phase 4 #6.
// Vérifié avant d'écrire ce script : robots.txt de khadamatnarsa.ma autorise ce chemin (standard
// Drupal, aucun Disallow sur /carte-interactive ni sur les query strings ?pfpv=), aucune connexion
// ni CAPTCHA requis pour voir la page. La carte est alimentée par une VUE DRUPAL server-side
// (formulaire exposé GET, champ "pfpv" = préfecture/province, ex. ?pfpv=48) — pas d'API JSON
// séparée : chaque centre est une carte HTML (<h3>nom</h3> + adresse + email + lien Google Maps
// contenant lat/lng). Filtre RST = 3 préfectures seulement (48=Rabat, 51=Salé, 58=Skhirate-Témara),
// donc 3 requêtes GET au total — pas de pagination détectée, pas d'aspiration du reste du site.
//
// Si la structure HTML change (balises renommées, 0 résultat retourné alors qu'un résultat était
// attendu) : ce script ÉCHOUE (throw), il n'écrit jamais un résultat vide ou partiel comme s'il
// était complet — le pipeline (run-import-narsa.js) n'efface alors aucune fiche existante.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT_FILE = path.join(__dirname, 'out', 'narsa_cct.json');
// Adresse de contact reprise de VAPID_SUBJECT (src/services/push.js) — déjà utilisée ailleurs dans
// le code comme contact technique Shoofly, pas une adresse inventée pour ce script.
const USER_AGENT = 'ShooflyDirectoryBot/1.0 (+https://shoofly.ma; contact: contact@shoofly.ma)';

// Préfectures RST vérifiées dans le <select id="edit-pfpv"> de la page (2026-09-30) — valeurs
// susceptibles de changer si NARSA modifie sa liste, d'où la vérification de cohérence en fin de
// script (au moins 1 centre par préfecture, sinon échec).
const PREFECTURES = [
  { value: '48', city: 'Rabat' },
  { value: '51', city: 'Salé' },
  { value: '58', city: 'Témara' }, // "SKHIRATE-TEMARA" côté NARSA — englobe Skhirat, gardé tel quel
];

function normalizeCore(s) {
  let out = (s || '').toLowerCase();
  out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return out;
}
function narsaId(name, city) {
  const key = normalizeCore(name) + '|' + normalizeCore(city);
  return 'narsa-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

// Découpe par carte (chaque carte commence par <h3>...) puis extrait chaque champ
// INDÉPENDAMMENT dans le morceau — plus robuste qu'une seule regex combinée à groupes optionnels
// (un premier essai avec tout-en-un a raté le champ email de façon inconsistante, piège classique
// de backtracking non-greedy sur un groupe optionnel suivi d'un autre joker paresseux).
function parseCards(html) {
  const chunks = html.split(/(?=<h3>)/).slice(1); // le 1er morceau (avant le 1er <h3>) n'est pas une carte
  const cards = [];
  for (const chunk of chunks) {
    const name = chunk.match(/<h3>([^<]+)<\/h3>/);
    const address = chunk.match(/Adresse du centre\s*:<\/strong>\s*([^<]*)<\/p>/);
    const email = chunk.match(/Adresse mail\s*:<\/strong>\s*([^<]*)<\/p>/);
    const coords = chunk.match(/query=([\-0-9.]+),\s*([\-0-9.]+)/);
    if (!name || !address || !coords) continue; // carte incomplète, ignorée (pas de champ inventé)
    cards.push({
      name: name[1].replace(/\s+/g, ' ').trim(),
      address: address[1].replace(/\s+/g, ' ').trim() || null,
      email: email ? email[1].trim() || null : null,
      lat: Number(coords[1]),
      lng: Number(coords[2]),
    });
  }
  return cards;
}

// Phase 5 quater (2026-10-01) — un échec réseau depuis Render (Frankfurt) remontait juste comme
// "fetch failed" (message générique d'undici/Node), sans jamais exposer error.cause où vit le vrai
// diagnostic (code TLS, DNS, timeout...). Investigation faite depuis cet environnement avant
// d'écrire ce correctif : chaîne de certificats de khadamatnarsa.ma vérifiée complète et valide
// (openssl s_client, les 2 niveaux intermédiaires sont bien envoyés par le serveur) ; requête HTTP
// réelle réussie (200, ~1s, cookies TS... caractéristiques d'un WAF F5 BIG-IP ASM). Hypothèse la
// plus probable : blocage par IP/géolocalisation côté WAF NARSA (IP de Rabat/Maroc acceptée, IP
// datacenter européenne Render refusée) — PAS un problème de certificat. Pas de contournement
// appliqué (décision BOSS) : ce log détaillé permettra de confirmer avec les vraies données du
// prochain run Render si l'échec persiste, et quelle en est la nature exacte.
function describeNetworkError(e) {
  const lines = [];
  let cur = e, depth = 0;
  while (cur && depth < 6) {
    const bits = [`${cur.name || 'Error'}: ${cur.message}`];
    if (cur.code) bits.push(`code=${cur.code}`);
    if (cur.errno) bits.push(`errno=${cur.errno}`);
    if (cur.syscall) bits.push(`syscall=${cur.syscall}`);
    if (cur.address) bits.push(`address=${cur.address}`);
    if (cur.port) bits.push(`port=${cur.port}`);
    lines.push(`  [profondeur ${depth}] ${bits.join(', ')}`);
    cur = cur.cause;
    depth++;
  }
  return lines.join('\n');
}

async function fetchPrefecture(pref) {
  const url = `https://khadamatnarsa.ma/fr/carte-interactive?pfpv=${pref.value}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  } catch (e) {
    throw new Error(`NARSA ${pref.city} (pfpv=${pref.value}) : échec réseau (voir détail ci-dessous — TLS/DNS/timeout/blocage possible)\n${describeNetworkError(e)}`);
  }
  if (!res.ok) throw new Error(`NARSA ${pref.city} (pfpv=${pref.value}) : HTTP ${res.status}`);
  const html = await res.text();
  const cards = parseCards(html);
  if (cards.length === 0) throw new Error(`NARSA ${pref.city} (pfpv=${pref.value}) : 0 centre extrait — structure HTML probablement changée, échec volontaire (pas d'écriture partielle)`);
  return cards.map((c) => ({
    narsa_id: narsaId(c.name, pref.city),
    name: c.name,
    address: c.address,
    phone: null, // absent de ce gabarit de carte NARSA — jamais inventé
    website: null,
    email: c.email,
    lat: c.lat,
    lng: c.lng,
    city: pref.city,
    category_id: 'visite_technique',
  }));
}

async function main() {
  const all = [];
  for (const pref of PREFECTURES) {
    console.log(`Fetch NARSA — ${pref.city} (pfpv=${pref.value})...`);
    const rows = await fetchPrefecture(pref);
    console.log(`  -> ${rows.length} centres`);
    all.push(...rows);
    await new Promise((r) => setTimeout(r, 500)); // espacement poli entre les 3 requêtes
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(all, null, 2));
  console.log('Total NARSA CCT (RST) :', all.length, '->', OUT_FILE);
}

if (require.main === module) main().catch((e) => { console.error('ERREUR NARSA:', e.message); process.exit(1); });
module.exports = { main, parseCards, narsaId };
