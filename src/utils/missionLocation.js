// ── Lieu de mission : validation des coordonnées + zone approximative (chantier « lieu de
// mission », phase 1 backend, 2026-09-24 — décisions BOSS Q1/Q3/Q4) ──
//
// Colonnes (db/schema.js) : missions.location_lat/location_lng = position EXACTE posée par le
// client ; missions.approx_lat/approx_lng = CENTRE de la zone approximative servie aux Œils non
// retenus d'un logement privé (utils/missionVisibility.js). Rayon = APPROX_RADIUS_M, constante
// renvoyée au frontend sous approx_radius_m.
//
// Zone approximative — calculée UNE fois, à l'écriture de la position exacte (création,
// modification directe, application d'une demande de modification), stockée, et recalculée
// SEULEMENT si la position exacte change. Jamais par requête : un décalage tiré à chaque appel
// se moyenne en quelques requêtes et redonne la position exacte. Jamais « exact + rayon » : le
// centre du cercle serait la position exacte.
//
// Formule (computeApproxCenter) — le centre est la position exacte décalée d'une distance d et
// d'un cap θ tirés au hasard (crypto) :
//   d = sqrt(DMIN² + u1·(DMAX² − DMIN²))   u1 ∈ [0,1) → d ∈ [DMIN, DMAX], uniforme EN SURFACE
//                                           sur la couronne (le vrai point n'est pas plus
//                                           probable près du bord intérieur)
//   θ = 2π·u2                               u2 ∈ [0,1)
//   Δlat = d·cosθ / R_T                      (radians, R_T = rayon terrestre moyen)
//   Δlng = d·sinθ / (R_T·cos(lat))
// avec DMIN = 0,4 × R et DMAX = 0,9 × R. Rayon R = 100 m depuis le 2026-09-25 (décision BOSS,
// 500 m auparavant ; migration unique des zones existantes dans db/schema.js) → DMIN = 40 m,
// DMAX = 90 m :
//   - le cercle de 100 m CONTIENT toujours le vrai point : d ≤ 90 m < 100 m. Marge de 10 m,
//     très au-dessus des erreurs cumulées (approximation plane locale < 1 mm à 90 m ; arrondi
//     à 6 décimales ≤ 0,08 m par coordonnée, sur le centre, et ≤ 0,08 m sur le point exact) ;
//   - le centre n'est JAMAIS proche du vrai point : d ≥ 40 m.
// Un Œil qui voit le cercle sait seulement que le lieu est dans une couronne de 40 à 90 m
// autour du centre affiché (≈ 2 000 m²), sans direction privilégiée.

const crypto = require('crypto');

const APPROX_RADIUS_M = 100; // 500 m jusqu'au 2026-09-25
const APPROX_MIN_OFFSET_M = 0.4 * APPROX_RADIUS_M; // 40 m
const APPROX_MAX_OFFSET_M = 0.9 * APPROX_RADIUS_M; // 90 m
const EARTH_RADIUS_M = 6371008.8;

// Boîte englobante du Maroc (Sahara compris), décision BOSS : rejette aussi l'inversion
// lat/lng la plus courante (33.5,-7.6 saisi -7.6,33.5 → lat hors boîte).
const MOROCCO_BOX = { latMin: 20.5, latMax: 36.1, lngMin: -17.3, lngMax: -0.9 };

const round6 = (x) => Math.round(x * 1e6) / 1e6;

// Nombre JS fini, ou chaîne numérique stricte (formulaire / JSON sérialisé ailleurs). Tout le
// reste (null, booléen, tableau, '', '12abc', NaN, Infinity) → null = invalide.
function toFiniteNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Paire location_lat/location_lng. `required` : création (Q1) — la paire DOIT être là.
// Retourne { lat, lng } (arrondis à 6 décimales, ou null/null si absente et non requise) ou
// { error }. « Absente » = les DEUX clés undefined ; une seule des deux → erreur (paire complète).
function validateLocationPair(rawLat, rawLng, { required = false } = {}) {
  if (rawLat === undefined && rawLng === undefined) {
    return required ? { error: 'Lieu de la mission requis : placez l\'épingle sur la carte.' } : { lat: null, lng: null };
  }
  if (rawLat === undefined || rawLng === undefined) {
    return { error: 'Position incomplète : location_lat et location_lng doivent être fournis ensemble.' };
  }
  const lat = toFiniteNumber(rawLat);
  const lng = toFiniteNumber(rawLng);
  if (lat === null || lng === null) return { error: 'Position invalide : coordonnées numériques attendues.' };
  const rLat = round6(lat);
  const rLng = round6(lng);
  const b = MOROCCO_BOX;
  if (rLat < b.latMin || rLat > b.latMax || rLng < b.lngMin || rLng > b.lngMax) {
    return { error: 'Position hors du Maroc (vérifiez que latitude et longitude ne sont pas inversées).' };
  }
  return { lat: rLat, lng: rLng };
}

// is_private_residence : booléen STRICT (Q4). undefined = absent (défaut par type à la
// création, inchangé en modification) ; toute autre valeur non booléenne ('true', 1, null) → erreur.
function validatePrivateFlag(raw) {
  if (raw === undefined) return { value: undefined };
  if (typeof raw !== 'boolean') return { error: 'is_private_residence doit être un booléen (true ou false).' };
  return { value: raw };
}

// Réel uniforme dans [0,1) sur 48 bits (crypto.randomInt plafonne à 2^48 − 1 d'écart).
function uniform01() {
  return crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

// `rand` injectable (tests déterministes) ; par défaut crypto.
// Nouveau tirage si le centre reprend À L'IDENTIQUE (6 décimales) la latitude ou la longitude
// exacte — cap quasi plein nord/sud ou est/ouest, probabilité ≈ 10⁻³ avec R = 100 m (2·10⁻⁴ à 500 m) : la valeur exacte
// n'apparaît ainsi jamais telle quelle dans une réponse (audit textuel sans faux positif). Écarte
// un ensemble de caps de mesure négligeable, sans effet sur la distribution utile. Borné à 8
// tirages (un `rand` constant de test renvoie le dernier).
function computeApproxCenter(lat, lng, rand = uniform01) {
  let out;
  for (let i = 0; i < 8; i++) {
    const u1 = rand();
    const u2 = rand();
    const d = Math.sqrt(APPROX_MIN_OFFSET_M ** 2 + u1 * (APPROX_MAX_OFFSET_M ** 2 - APPROX_MIN_OFFSET_M ** 2));
    const theta = 2 * Math.PI * u2;
    const phi = (lat * Math.PI) / 180;
    const dLat = (d * Math.cos(theta)) / EARTH_RADIUS_M;
    const dLng = (d * Math.sin(theta)) / (EARTH_RADIUS_M * Math.cos(phi));
    out = {
      lat: round6(lat + (dLat * 180) / Math.PI),
      lng: round6(lng + (dLng * 180) / Math.PI),
    };
    if (out.lat !== round6(lat) && out.lng !== round6(lng)) break;
  }
  return out;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lng2 - lng1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Complète un objet de changements validés (validateMissionEditFields) avec la NOUVELLE zone
// approximative quand la position exacte y figure — seul point de calcul pour toute écriture
// d'une position après création (PUT /:id direct, admin-edit, approbation d'une demande de
// modification, application forcée à la suspension d'un Œil). proposed_changes ne stocke que
// la position exacte : la zone est tirée au moment où la modification est APPLIQUÉE.
function withApproxZone(changes) {
  if (!changes || !('location_lat' in changes)) return changes;
  const approx = computeApproxCenter(Number(changes.location_lat), Number(changes.location_lng));
  return { ...changes, approx_lat: approx.lat, approx_lng: approx.lng };
}

// ── Verrou du caractère « logement privé » (Q4) ──
// « Un Œil a postulé » — défini d'après le code réel, et DURABLE (une trace qui disparaît ne
// doit pas déverrouiller) ; vrai dès que l'un de ces faits est établi :
//   1. missions.oeil_id non NULL — Œil retenu (réservation directe à la création, sélection
//      client/admin, confirmation dans la cascade) ;
//   2. une ligne mission_interests existe pour la mission, quel que soit son état — candidature
//      spontanée (POST /:id/interest), candidat sollicité par la cascade (solicited_at),
//      confirmé (confirmed_at) ou ayant refusé (declined). Les lignes sont SUPPRIMÉES dans
//      plusieurs chemins (retrait de candidature, timeout de sollicitation, désassignement) —
//      d'où les critères 3 à 5 ;
//   3. l'historique de statut contient une affectation (assigned/en_route/active/completed) —
//      un Œil a été retenu à un moment, même s'il a été désassigné depuis ;
//   4. missions.transferred_from non NULL — mission reprise à un Œil (transfert, suspension,
//      réservation directe puis désassignement : ce dernier cas n'écrit pas de ligne
//      'assigned' dans l'historique, insertMissionRecord trace 'pending') ;
//   5. statut ≠ 'pending' — hors recherche (assignée, en cours, close, réclamation).
// Limite connue : un Œil qui a candidaté puis RETIRÉ sa candidature, sur une mission jamais
// affectée, ne laisse aucune trace (ligne supprimée) — le verrou ne s'applique alors pas.
// Utilisé tel quel comme garde SQL de l'UPDATE (course candidature ↔ modification).
const PRIVACY_FLAG_LOCK_SQL = `(
  missions.oeil_id IS NOT NULL
  OR missions.status <> 'pending'
  OR missions.transferred_from IS NOT NULL
  OR EXISTS (SELECT 1 FROM mission_interests mi WHERE mi.mission_id = missions.id)
  OR EXISTS (SELECT 1 FROM mission_status_history h
             WHERE h.mission_id = missions.id AND h.status IN ('assigned','en_route','active','completed'))
)`;
const PRIVACY_FLAG_LOCKED_ERROR = 'Le caractère « logement privé » ne peut plus être modifié : un Œil a déjà postulé à cette mission.';

async function isPrivacyFlagLocked(db, missionId) {
  const { rows: [r] } = await db.query(`SELECT ${PRIVACY_FLAG_LOCK_SQL} AS locked FROM missions WHERE id=$1`, [missionId]);
  return !!(r && r.locked);
}

module.exports = {
  APPROX_RADIUS_M,
  APPROX_MIN_OFFSET_M,
  APPROX_MAX_OFFSET_M,
  MOROCCO_BOX,
  round6,
  validateLocationPair,
  validatePrivateFlag,
  computeApproxCenter,
  haversineMeters,
  withApproxZone,
  PRIVACY_FLAG_LOCK_SQL,
  PRIVACY_FLAG_LOCKED_ERROR,
  isPrivacyFlagLocked,
};
