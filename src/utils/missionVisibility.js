// ── Sérialisation d'une mission selon l'appelant (chantier « lieu de mission », 2026-09-24) ──
// Point de sortie UNIQUE des objets mission renvoyés par les routes R1 à R8 (voir
// rapport-chantier-audit-lieu-mission-carte-2026-09-24.md §2.1). Avant, le cercle de confiance
// était recopié route par route (`= null` dans GET / et GET /:id) et GET /?mode=available avait
// oublié `address` — d'où une seule fonction ici.
//
// Cercle de confiance (canSeeExact) : admin, client PROPRIÉTAIRE, Œil ACTUELLEMENT assigné
// (mission.oeil_id tel qu'il est APRÈS l'écriture pour les routes qui désassignent, ex.
// edit-requests/:id/reject).
//
// Règles (décisions BOSS 2026-09-24) :
//   - transfer_reason / transferred_from : masqués hors cercle (POINT 2 audit sécurité 08-09,
//     inchangé) — révèlent le motif d'urgence ou le blocage d'un collègue précédent.
//   - client_phone / client_email : règle historique inchangée, PLUS stricte que le cercle —
//     admin ou Œil assigné uniquement (le client propriétaire ne reçoit pas son propre contact).
//   - LIEU (address, location_lat, location_lng — et les mêmes clés de
//     pending_edit_request.proposed_changes) : visible par TOUT Œil avant candidature (le lieu
//     fait partie de l'annonce), SAUF logement privé (is_private_residence) pour qui ne peut pas
//     voir l'exact (canSeeExactLocation) → ces clés à null, et la zone approximative
//     (approx_lat, approx_lng + approx_radius_m) est servie à la place. Dans tous les autres cas
//     approx_* ne sont PAS envoyés (inutiles quand l'exact est visible).
//   - canSeeExactLocation = cercle de confiance, sauf pour l'Œil retenu dont l'accès EXPIRE
//     48 h après la clôture (Q7 : completed ou cancelled, date = missions.closed_at, posée par
//     transitionMission à chaque (ré)clôture) : il retombe alors sur la zone approximative. Même
//     règle pour les missions urgentes / prioritaires (Q9 : aucune exception).
// Ne crée jamais de clé absente, sauf approx_radius_m quand une zone est servie : seules les
// clés déjà présentes dans l'objet sont masquées, la forme de chaque réponse reste identique.

const { APPROX_RADIUS_M } = require('./missionLocation');

const RETAINED_OEIL_EXACT_GRACE_MS = 48 * 60 * 60 * 1000;
const CLOSED_STATUSES = ['completed', 'cancelled'];
const LOCATION_KEYS = ['address', 'location_lat', 'location_lng'];

function isAdmin(user) {
  return user?.role === 'admin';
}

function canSeeExact(user, mission) {
  if (!user || !mission) return false;
  if (isAdmin(user)) return true;
  if (user.role === 'client' && mission.client_id === user.id) return true;
  return !!mission.oeil_id && mission.oeil_id === user.id;
}

// `now` injectable (tests : horloge simulée).
function canSeeExactLocation(user, mission, now = Date.now()) {
  if (!canSeeExact(user, mission)) return false;
  if (isAdmin(user) || user.role === 'client') return true;
  // Œil retenu : exact jusqu'à 48 h après la clôture.
  if (!CLOSED_STATUSES.includes(mission.status)) return true;
  // Mission close sans date de clôture connue (antérieure à closed_at, ou objet sans la
  // colonne) : prudence, la fenêtre est considérée comme écoulée.
  if (!mission.closed_at) return false;
  return now < new Date(mission.closed_at).getTime() + RETAINED_OEIL_EXACT_GRACE_MS;
}

function hideLocation(user, mission, now) {
  return !!mission.is_private_residence && !canSeeExactLocation(user, mission, now);
}

function maskKeys(obj, keys) {
  for (const k of keys) if (k in obj) obj[k] = null;
}

// proposed_changes d'une demande de modification (objet JSONB) — copie masquée, jamais l'objet
// d'origine (il peut être partagé avec editRequest, renvoyé ailleurs dans la même réponse).
function serializeProposedChangesFor(user, mission, proposedChanges, now = Date.now()) {
  if (!proposedChanges || typeof proposedChanges !== 'object') return proposedChanges;
  if (!hideLocation(user, mission, now) || !LOCATION_KEYS.some((k) => k in proposedChanges)) return proposedChanges;
  const out = { ...proposedChanges };
  maskKeys(out, LOCATION_KEYS);
  return out;
}

function serializeMissionFor(user, mission, now = Date.now()) {
  if (!mission) return mission;
  const out = { ...mission };
  const exact = canSeeExact(user, mission);

  if (!(isAdmin(user) || (!!mission.oeil_id && mission.oeil_id === user?.id))) {
    maskKeys(out, ['client_phone', 'client_email']);
  }
  if (!exact) {
    maskKeys(out, ['transfer_reason', 'transferred_from']);
  }
  if (hideLocation(user, mission, now)) {
    maskKeys(out, LOCATION_KEYS);
    if (out.approx_lat != null && out.approx_lng != null) out.approx_radius_m = APPROX_RADIUS_M;
  } else {
    delete out.approx_lat;
    delete out.approx_lng;
  }
  if (out.pending_edit_request && typeof out.pending_edit_request === 'object') {
    out.pending_edit_request = {
      ...out.pending_edit_request,
      proposed_changes: serializeProposedChangesFor(user, mission, out.pending_edit_request.proposed_changes, now),
    };
  }
  return out;
}

module.exports = { serializeMissionFor, serializeProposedChangesFor, canSeeExact, canSeeExactLocation, RETAINED_OEIL_EXACT_GRACE_MS };
