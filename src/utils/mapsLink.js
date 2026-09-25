// ── Résolution d'un lien Google Maps collé par le client → { lat, lng } (chantier « lieu de
// mission », phase 1 backend, 2026-09-24 — audit §3.3) ──
//
// Le lien collé n'est qu'un RACCOURCI pour placer l'épingle : la carte reste la source de vérité
// (le client valide visuellement), le lien brut n'est jamais stocké, aucun géocodage de texte.
//
// Liens longs (google.<tld>/maps…, maps.google.<tld>/…) : décodés SANS réseau.
// Liens courts (maps.app.goo.gl/…, goo.gl/maps/…) : on suit la redirection HTTP à la main.
//
// Garde-fous SSRF (le serveur ne doit jamais devenir un relais vers autre chose que Google) :
//   - chaque URL (l'entrée ET chaque saut) passe par new URL() puis une liste blanche d'hôtes
//     EXACTE : https uniquement, aucun port explicite, aucun identifiant (user@host), aucune IP
//     littérale ;
//   - redirect: 'manual' — jamais 'follow' (fetch suivrait une redirection vers une IP interne
//     sans passer par nos contrôles) ; 3 requêtes sortantes au plus, liste blanche revérifiée
//     à chaque saut ;
//   - délai global 5 s ; le corps n'est JAMAIS lu (annulé dès réception des en-têtes) ;
//   - la réponse ne contient que { lat, lng } — jamais l'URL finale ni un contenu relayé ;
//   - consent.google.<tld> (page de consentement selon la région de l'IP serveur) : jamais
//     suivie ; l'URL cible est lue dans son paramètre continue= et repasse la liste blanche.
//
// Décodage, par ordre de précision décroissante :
//   1. !3d<lat>!4d<lng> (l'épingle du lieu ; dernière occurrence) ;
//   2. paramètres q / query / ll / destination de la forme « lat,lng » (préfixe loc: toléré),
//      puis un segment de chemin /maps/search|place|dir/…/lat,lng ;
//   3. @lat,lng (centre de l'écran, pas l'épingle) — dernier recours.

const MAX_HOPS = 3;
const TIMEOUT_MS = 5000;
const MAX_INPUT_LENGTH = 2048;

class MapsLinkError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const ERR = {
  invalid: () => new MapsLinkError('INVALID_LINK', 400, 'Lien invalide : collez un lien Google Maps (maps.app.goo.gl ou google.com/maps).'),
  refused: () => new MapsLinkError('REDIRECT_REFUSED', 400, 'Lien refusé : la redirection sort de Google Maps.'),
  tooMany: () => new MapsLinkError('TOO_MANY_REDIRECTS', 400, 'Lien refusé : trop de redirections.'),
  unrecognized: () => new MapsLinkError('UNRECOGNIZED', 422, 'Lien non reconnu : placez l\'épingle sur la carte.'),
  timeout: () => new MapsLinkError('TIMEOUT', 504, 'Google Maps n\'a pas répondu à temps : placez l\'épingle sur la carte.'),
  upstream: () => new MapsLinkError('UPSTREAM', 502, 'Impossible de lire ce lien pour le moment : placez l\'épingle sur la carte.'),
};

const TLD = '(?:com|co\\.[a-z]{2}|com\\.[a-z]{2}|[a-z]{2})';
const GOOGLE_WWW_RE = new RegExp(`^(?:www\\.)?google\\.${TLD}$`);
const GOOGLE_MAPS_HOST_RE = new RegExp(`^maps\\.google\\.${TLD}$`);
const CONSENT_RE = new RegExp(`^consent\\.google\\.${TLD}$`);

// new URL() + contrôles communs. null si l'URL n'est pas acceptable, quel que soit l'hôte.
function parseSafeUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port) return null;
  const h = u.hostname.toLowerCase();
  // IP littérale (IPv4, forme décimale/hexa normalisée par WHATWG en IPv4, IPv6 entre crochets)
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return null;
  return u;
}

// 'short' (à suivre), 'maps' (à décoder), 'consent' (à dépiler via continue=), ou null (refusé).
function classify(u) {
  if (!u) return null;
  const h = u.hostname.toLowerCase();
  const p = u.pathname;
  if (h === 'maps.app.goo.gl') return p.length > 1 ? 'short' : null;
  if (h === 'goo.gl') return /^\/maps\/./.test(p) ? 'short' : null;
  if (GOOGLE_MAPS_HOST_RE.test(h)) return 'maps';
  if (GOOGLE_WWW_RE.test(h)) return /^\/maps(\/|$)/.test(p) ? 'maps' : null;
  if (CONSENT_RE.test(h)) return 'consent';
  return null;
}

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
const PAIR_RE = new RegExp(`^(?:loc:)?\\s*${NUM}\\s*,\\s*${NUM}\\s*$`);

function plausible(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < -90 || a > 90 || b < -180 || b > 180) return null;
  return { lat: a, lng: b };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Coordonnées d'une URL Google Maps longue, sans réseau. { lat, lng, source } ou null.
function decodeMapsUrl(u) {
  const href = safeDecode(u.href);

  // 1. !3d!4d — dernière occurrence (l'épingle du lieu dans data=…!8m2!3d…!4d…)
  const pins = [...href.matchAll(new RegExp(`!3d${NUM}!4d${NUM}`, 'g'))];
  for (let i = pins.length - 1; i >= 0; i--) {
    const c = plausible(pins[i][1], pins[i][2]);
    if (c) return { ...c, source: '3d4d' };
  }

  // 2. paramètres explicites, puis segment de chemin « lat,lng »
  for (const key of ['q', 'query', 'll', 'destination']) {
    const v = u.searchParams.get(key);
    const m = v && v.match(PAIR_RE);
    if (m) {
      const c = plausible(m[1], m[2]);
      if (c) return { ...c, source: key };
    }
  }
  const seg = u.pathname.match(/^\/maps\/(?:search|place|dir)\/(.+)$/);
  if (seg) {
    for (const part of seg[1].split('/')) {
      const m = safeDecode(part).replace(/\+/g, ' ').match(PAIR_RE);
      if (m) {
        const c = plausible(m[1], m[2]);
        if (c) return { ...c, source: 'path' };
      }
    }
  }

  // 3. @lat,lng — centre de l'écran, dernier recours
  const at = u.pathname.match(new RegExp(`@${NUM},${NUM}(?:,|$)`));
  if (at) {
    const c = plausible(at[1], at[2]);
    if (c) return { ...c, source: 'at' };
  }
  return null;
}

// Le texte partagé par l'app mobile contient souvent un nom de lieu puis le lien : on garde le
// premier jeton https:// (aucun autre traitement du texte).
function extractUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MAX_INPUT_LENGTH) return null;
  if (!/\s/.test(s)) return s;
  const m = s.match(/https:\/\/\S+/);
  return m ? m[0] : null;
}

function isTimeout(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 23);
}

// `fetchImpl` injectable (tests : bouchon qui journalise chaque requête sortante).
async function resolveMapsLink(raw, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, maxHops = MAX_HOPS } = {}) {
  let u = parseSafeUrl(extractUrl(raw));
  let kind = classify(u);
  if (!kind) throw ERR.invalid();

  const signal = AbortSignal.timeout(timeoutMs);
  let hops = 0;
  let consentUnwrapped = false;
  for (;;) {
    if (kind === 'maps') {
      const c = decodeMapsUrl(u);
      if (!c) throw ERR.unrecognized();
      return c;
    }
    if (kind === 'consent') {
      if (consentUnwrapped) throw ERR.refused();
      consentUnwrapped = true;
      const next = parseSafeUrl(u.searchParams.get('continue'));
      const nextKind = classify(next);
      if (!nextKind || nextKind === 'consent') throw ERR.refused();
      u = next;
      kind = nextKind;
      continue;
    }
    // kind === 'short' : une requête sortante, en-têtes seulement.
    if (hops >= maxHops) throw ERR.tooMany();
    hops++;
    let res;
    try {
      res = await fetchImpl(u.href, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Shoofly/1.0)', 'Accept-Language': 'fr' },
      });
    } catch (e) {
      throw isTimeout(e) || signal.aborted ? ERR.timeout() : ERR.upstream();
    }
    try { await res.body?.cancel(); } catch { /* corps jamais lu */ }
    if (![301, 302, 303, 307, 308].includes(res.status)) throw ERR.unrecognized();
    const loc = res.headers.get('location');
    if (!loc) throw ERR.unrecognized();
    let abs;
    try { abs = new URL(loc, u).href; } catch { throw ERR.refused(); }
    const next = parseSafeUrl(abs);
    const nextKind = classify(next);
    if (!nextKind) throw ERR.refused();
    u = next;
    kind = nextKind;
  }
}

module.exports = { resolveMapsLink, decodeMapsUrl, parseSafeUrl, classify, extractUrl, MapsLinkError, MAX_HOPS, TIMEOUT_MS };
