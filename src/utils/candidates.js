// ── Candidatures visibles par le client : UNE seule définition ─────────────────────────────
// Décision BOSS (audit notifications, 2026-10-06, point 2) : « le nombre de candidatures » est
// EXACTEMENT ce que le client voit dans sa liste de candidats (GET /missions/:id/interests). Le
// seuil « 3ᵉ candidat », la relance « des Œils attendent votre choix », la relance WhatsApp et
// l'alerte admin « mission proche sans candidature » passent tous par ce module : aucun ne recompte
// de son côté.
//
// Règle = candidatures non déclinées (mission_interests.declined = false), hors Œil transféré de
// la mission, PUIS retrait des Œils qui échouent checkOeilAssignable en mode bulk (vérifié,
// disponible, non suspendu, sans conflit de créneau). Un Œil non vérifié n'est donc pas compté,
// comme il n'est pas affiché au client.
const { checkOeilsAssignableBulk } = require('./oeilAssignment');

// Colonnes et filtres identiques à la liste client de GET /missions/:id/interests. Les lignes ne
// sont pas masquées ici : la route garde la sérialisation (note masquée, unavailable, etc.).
async function listCandidateRows(db, mission, { includeDeclined = false } = {}) {
  const { rows } = await db.query(
    `SELECT u.id, u.first_name, u.last_name, u.city, u.avatar_url,
            p.rating_avg, p.rating_count, p.total_missions, p.bio, p.coverage_zone,
            mi.message, mi.created_at as interested_at
     FROM mission_interests mi
     JOIN users u ON u.id = mi.oeil_id
     LEFT JOIN oeil_profiles p ON p.user_id = mi.oeil_id
     WHERE mi.mission_id = $1
       AND ($3::boolean OR mi.declined = false)
       AND mi.oeil_id IS DISTINCT FROM $2
     ORDER BY mi.created_at ASC`,
    [mission.id, mission.transferred_from, includeDeclined]
  );
  return rows;
}

// Retire les candidats que le client ne doit pas voir (même filtre que l'écran client).
async function keepClientVisible(db, rows, mission) {
  if (rows.length === 0) return [];
  const eligibility = await checkOeilsAssignableBulk(db, rows.map(o => o.id), {
    scheduledAt: mission.scheduled_at,
    excludeMissionId: mission.id,
  });
  return rows.filter(o => eligibility[o.id]?.ok === true);
}

// Candidats visibles par le client (même liste que l'écran client).
async function listClientVisibleCandidates(db, mission) {
  return keepClientVisible(db, await listCandidateRows(db, mission), mission);
}

// Nombre de candidatures telles que le client les voit. C'est LE chiffre à afficher partout.
async function countClientVisibleCandidates(db, mission) {
  return (await listClientVisibleCandidates(db, mission)).length;
}

// Charge la mission avec les champs nécessaires au comptage (par id).
async function countVisibleForMissionId(db, missionId) {
  const { rows: [mission] } = await db.query(
    'SELECT id, scheduled_at, transferred_from FROM missions WHERE id=$1', [missionId]
  );
  return mission ? countClientVisibleCandidates(db, mission) : 0;
}

module.exports = {
  listCandidateRows,
  keepClientVisible,
  listClientVisibleCandidates,
  countClientVisibleCandidates,
  countVisibleForMissionId,
};
