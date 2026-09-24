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
// Règles (décision BOSS 2026-09-24) :
//   - transfer_reason / transferred_from : masqués hors cercle (POINT 2 audit sécurité 08-09,
//     inchangé) — révèlent le motif d'urgence ou le blocage d'un collègue précédent.
//   - client_phone / client_email : règle historique inchangée, PLUS stricte que le cercle —
//     admin ou Œil assigné uniquement (le client propriétaire ne reçoit pas son propre contact).
//   - address (et pending_edit_request.proposed_changes.address) : visible par TOUT Œil avant
//     candidature (le lieu fait partie de l'annonce), SAUF logement privé
//     (is_private_residence) hors cercle → null.
// Ne crée jamais de clé absente : seules les clés déjà présentes dans l'objet sont masquées,
// pour garder la forme de réponse de chaque route identique.

function isAdmin(user) {
  return user?.role === 'admin';
}

function canSeeExact(user, mission) {
  if (!user || !mission) return false;
  if (isAdmin(user)) return true;
  if (user.role === 'client' && mission.client_id === user.id) return true;
  return !!mission.oeil_id && mission.oeil_id === user.id;
}

function hideAddress(user, mission) {
  return !!mission.is_private_residence && !canSeeExact(user, mission);
}

function maskKeys(obj, keys) {
  for (const k of keys) if (k in obj) obj[k] = null;
}

// proposed_changes d'une demande de modification (objet JSONB) — copie masquée, jamais l'objet
// d'origine (il peut être partagé avec editRequest, renvoyé ailleurs dans la même réponse).
function serializeProposedChangesFor(user, mission, proposedChanges) {
  if (!proposedChanges || typeof proposedChanges !== 'object') return proposedChanges;
  if (!hideAddress(user, mission) || !('address' in proposedChanges)) return proposedChanges;
  return { ...proposedChanges, address: null };
}

function serializeMissionFor(user, mission) {
  if (!mission) return mission;
  const out = { ...mission };
  const exact = canSeeExact(user, mission);

  if (!(isAdmin(user) || (!!mission.oeil_id && mission.oeil_id === user?.id))) {
    maskKeys(out, ['client_phone', 'client_email']);
  }
  if (!exact) {
    maskKeys(out, ['transfer_reason', 'transferred_from']);
  }
  if (hideAddress(user, mission)) {
    maskKeys(out, ['address']);
  }
  if (out.pending_edit_request && typeof out.pending_edit_request === 'object') {
    out.pending_edit_request = {
      ...out.pending_edit_request,
      proposed_changes: serializeProposedChangesFor(user, mission, out.pending_edit_request.proposed_changes),
    };
  }
  return out;
}

module.exports = { serializeMissionFor, serializeProposedChangesFor, canSeeExact };
