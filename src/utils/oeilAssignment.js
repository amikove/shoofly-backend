const { getSetting } = require('./settings');

// ── Réutilisable : vérifie qu'un Œil est assignable à une mission ──
// Un seul jeu de règles, 3 appelants : prepareMissionInsert (réservation directe / PayZone,
// routes/missions.js), hireOeilCore (client accepte une candidature, routes/missions.js) et
// POST /:id/assign-admin (affectation manuelle par un admin, routes/missions.js). Extrait le
// 2026-07-27 (Partie F) du bloc de validation ajouté à prepareMissionInsert le 2026-07-27
// (Partie E, commit 25d88be) — comportement de ce premier appelant strictement inchangé.
//
// 5 vérifications, dans cet ordre : Œil existe + role='oeil', is_verified, is_available,
// (is_suspended OU !is_active) regroupés en un seul contrôle "bloqué" — message générique
// volontaire, ne jamais communiquer au client la raison précise (suspension vs anti-fraude),
// information interne de fiabilité —, puis conflit de créneau. Les 4 autres contrôles sont
// TOUJOURS bloquants quel que soit l'appelant : `overridable` ne donne jamais accès qu'au
// seul contrôle is_suspended/is_active (seul assign-admin s'en sert, avec confirmation
// explicite de l'admin — voir spec réattribution 2026-07-27).
//
// scheduledAt : `scheduled_at` de la mission concernée (déjà un Date ou une string parseable).
// excludeMissionId : id de la mission en cours, à exclure du calcul de conflit — absent pour
//   une mission pas encore créée (prepareMissionInsert), présent pour hireOeilCore/assign-admin
//   qui réattribuent une mission déjà existante (même requête verbatim que l'existant, avec
//   ou sans la clause d'exclusion selon le cas).
// overridable : si true, une suspension/blocage anti-fraude ne fait pas échouer ce contrôle —
//   mais reste signalée via isSuspended/isActive en retour, pour que l'appelant décide lui-même
//   de la confirmation et trace l'override le cas échéant.
//
// Ne fait aucune écriture DB. Retourne { error, code } si une vérification bloque (rejet
// définitif quel que soit l'appelant), sinon { ok:true, isSuspended, isActive } — ces deux
// derniers champs permettent à l'appelant de savoir si is_suspended/is_active auraient bloqué
// sans le paramètre overridable, pour tracer un éventuel override.
async function checkOeilAssignable(db, oeilId, { scheduledAt, excludeMissionId = null, overridable = false } = {}) {
  const { rows: [oeilCheck] } = await db.query(
    `SELECT u.role, u.is_active, u.is_suspended, p.is_verified, p.is_available
     FROM users u JOIN oeil_profiles p ON p.user_id=u.id
     WHERE u.id=$1`,
    [oeilId]
  );
  if (!oeilCheck || oeilCheck.role !== 'oeil') return { error: 'Œil introuvable', code: 'not_found' };
  if (!oeilCheck.is_verified) return { error: 'Cet Œil n\'est pas encore vérifié.', code: 'not_verified' };
  if (!oeilCheck.is_available) return { error: 'Cet Œil n\'est pas disponible actuellement.', code: 'not_available' };

  const isSuspended = !!oeilCheck.is_suspended;
  const isActive = !!oeilCheck.is_active;
  if ((isSuspended || !isActive) && !overridable) {
    // Message volontairement générique (suspendu / bloqué anti-fraude) — la raison précise
    // est une information interne de fiabilité, non communicable au client.
    return { error: 'Cet Œil n\'est plus disponible pour cette mission.', code: 'suspended_or_blocked' };
  }

  const scheduleConflictWindowHours = await getSetting(db, 'schedule_conflict_window_hours', 4);
  const baseParams = [oeilId, new Date(scheduledAt), scheduleConflictWindowHours];
  const { rows: creneauConflicts } = await db.query(`
    SELECT m.id FROM missions m
    WHERE m.oeil_id = $1
      AND m.status IN ('assigned','en_route','active')
      ${excludeMissionId ? 'AND m.id != $4' : ''}
      AND ABS(EXTRACT(EPOCH FROM (m.scheduled_at - $2)) / 3600) < $3::numeric
  `, excludeMissionId ? [...baseParams, excludeMissionId] : baseParams);
  if (creneauConflicts.length > 0) {
    return { error: 'Cet Œil a déjà une mission dans le même créneau.', code: 'schedule_conflict' };
  }

  return { ok: true, isSuspended, isActive };
}

// ── Conflit de créneau, en bulk ─────────────────────────────
// Même requête que la clause finale de checkOeilAssignable ci-dessus, mais pour un lot
// d'Œils en une seule requête (ANY($1)) plutôt qu'en boucle. Isolée de checkOeilsAssignableBulk
// ci-dessous car certains appelants (picker admin) ont besoin du signal de conflit de façon
// indépendante des 4 autres vérifications — contrairement à checkOeilsAssignableBulk, qui
// court-circuite dès la première vérification en échec, cette fonction calcule le conflit pour
// tous les ids demandés sans condition.
async function getScheduleConflictSetBulk(db, oeilIds, { scheduledAt, excludeMissionId = null } = {}) {
  const ids = [...new Set((oeilIds || []).filter(Boolean))];
  if (ids.length === 0) return new Set();

  const scheduleConflictWindowHours = await getSetting(db, 'schedule_conflict_window_hours', 4);
  const baseParams = [ids, new Date(scheduledAt), scheduleConflictWindowHours];
  const { rows } = await db.query(`
    SELECT DISTINCT m.oeil_id FROM missions m
    WHERE m.oeil_id = ANY($1::text[])
      AND m.status IN ('assigned','en_route','active')
      ${excludeMissionId ? 'AND m.id != $4' : ''}
      AND ABS(EXTRACT(EPOCH FROM (m.scheduled_at - $2)) / 3600) < $3::numeric
  `, excludeMissionId ? [...baseParams, excludeMissionId] : baseParams);
  return new Set(rows.map(r => r.oeil_id));
}

// ── checkOeilAssignable, en bulk ────────────────────────────
// Même 5 vérifications, même ordre, mêmes codes d'erreur que checkOeilAssignable ci-dessus —
// dupliquée plutôt que factorisée pour ne prendre aucun risque sur le chemin d'écriture
// existant (prepareMissionInsert / hireOeilCore / assign-admin, qui continuent d'appeler
// checkOeilAssignable tel quel). Si les règles des 5 vérifications changent un jour, répercuter
// le changement ici aussi. Deux requêtes au total quel que soit le nombre d'Œils (une pour les
// champs users/oeil_profiles, une pour les conflits via getScheduleConflictSetBulk) — ajoutée
// pour GET /:id/interests (masquage des candidatures inéligibles côté client), qui aurait sinon
// dû appeler checkOeilAssignable en boucle, un appel par candidat.
async function checkOeilsAssignableBulk(db, oeilIds, { scheduledAt, excludeMissionId = null, overridable = false } = {}) {
  const ids = [...new Set((oeilIds || []).filter(Boolean))];
  const result = {};
  if (ids.length === 0) return result;

  const { rows: oeilChecks } = await db.query(
    `SELECT u.id, u.role, u.is_active, u.is_suspended, p.is_verified, p.is_available
     FROM users u JOIN oeil_profiles p ON p.user_id=u.id
     WHERE u.id = ANY($1::text[])`,
    [ids]
  );
  const byId = new Map(oeilChecks.map(r => [r.id, r]));
  const conflictSet = await getScheduleConflictSetBulk(db, ids, { scheduledAt, excludeMissionId });

  for (const id of ids) {
    const oeilCheck = byId.get(id);
    if (!oeilCheck || oeilCheck.role !== 'oeil') { result[id] = { error: 'Œil introuvable', code: 'not_found' }; continue; }
    if (!oeilCheck.is_verified) { result[id] = { error: 'Cet Œil n\'est pas encore vérifié.', code: 'not_verified' }; continue; }
    if (!oeilCheck.is_available) { result[id] = { error: 'Cet Œil n\'est pas disponible actuellement.', code: 'not_available' }; continue; }

    const isSuspended = !!oeilCheck.is_suspended;
    const isActive = !!oeilCheck.is_active;
    if ((isSuspended || !isActive) && !overridable) {
      result[id] = { error: 'Cet Œil n\'est plus disponible pour cette mission.', code: 'suspended_or_blocked' };
      continue;
    }

    if (conflictSet.has(id)) {
      result[id] = { error: 'Cet Œil a déjà une mission dans le même créneau.', code: 'schedule_conflict' };
      continue;
    }

    result[id] = { ok: true, isSuspended, isActive };
  }

  return result;
}

module.exports = { checkOeilAssignable, checkOeilsAssignableBulk, getScheduleConflictSetBulk };
