// Source unique de vérité pour les transitions de statut d'une mission.
//
// Avant ce module, 12 endroits distincts (missions.js, users.js, index.js/crons)
// faisaient chacun leur propre "UPDATE missions SET status=... WHERE id=$1 AND
// status=$2" avec une garde ad-hoc, et seuls ~6 appelaient logStatus() ensuite.
// Toute transition non listée ci-dessous devient impossible.
//
// Portée volontairement limitée aux 7 états actuels (pending, assigned, en_route,
// active, completed, cancelled, sous_reclamation). Les futurs états évoqués
// (suspendue, litige, expirée, réouverte...) ne sont PAS construits ici — seule la
// structure TRANSITIONS ci-dessous doit être étendue le jour où leurs règles
// métier seront définies ; c'est le point d'extension prévu.
const { logStatus } = require('./missionHistory');

const TRANSITIONS = {
  // pending -> assigned : embauche (hireOeilCore, self-accept, affectation admin)
  // pending -> cancelled : expiration sans remplaçant, annulation depuis la file d'attente
  pending:          ['assigned', 'cancelled'],
  // assigned -> pending : refus, transfert avant démarrage, edit-request refusée/expirée
  assigned:         ['pending', 'en_route', 'cancelled'],
  // en_route/active -> pending : transfert signalé en cours de route ou en cours de mission
  // (POST /:id/transfer autorise le transfert depuis ces 2 statuts, pas seulement 'assigned')
  en_route:         ['pending', 'active', 'cancelled'],
  active:           ['pending', 'completed', 'cancelled'],
  completed:        ['sous_reclamation'],
  sous_reclamation: ['completed', 'cancelled'],
  cancelled:        [],
};

class MissionTransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MissionTransitionError';
    this.code = code;
  }
}

function isTransitionAllowed(fromStatus, toStatus) {
  return TRANSITIONS[fromStatus]?.includes(toStatus) ?? false;
}

// db : soit le pool (getDb()), soit un client déjà en transaction (voir
// walletService.withTransaction) — les deux exposent la même API .query(), donc
// cette fonction est composable avec un mouvement financier dans la même
// transaction atomique sans rien changer à son fonctionnement.
//
// extraFields : colonnes additionnelles à écrire dans le MÊME UPDATE (ex:
// { oeil_id: null, cancelled_at: 'NOW()', cancel_reason: '...' }) — cette fonction
// reste centrée sur "la transition est valide + appliquée + tracée", elle ne
// connaît pas les effets de bord métier (remboursement, pénalité, notification) :
// ceux-ci restent à la charge de la route appelante, après un transitionMission()
// réussi.
//
// extraGuards : conditions supplémentaires AND-ées dans le WHERE de ce même UPDATE
// (ex: { oeil_id: req.user.id }) — certaines routes vérifient aujourd'hui la
// propriété (quel Œil est assigné) sur un snapshot lu AVANT l'update plutôt que
// dans la clause atomique elle-même ; extraGuards permet de faire porter cette
// vérification par la garde optimiste, comme le fait déjà `status`, au lieu de
// dépendre d'un couplage implicite entre changement de statut et changement
// d'oeil_id (fragile — cf. audit ME-002, point C1 : "ancien Œil termine quand
// même la mission" n'est aujourd'hui évité que par hasard, pas par construction).
async function transitionMission(db, missionId, fromStatus, toStatus, actor, options = {}) {
  const { extraFields = {}, extraGuards = {}, note = null } = options;

  if (!isTransitionAllowed(fromStatus, toStatus)) {
    throw new MissionTransitionError('INVALID_TRANSITION', `Transition invalide: ${fromStatus} → ${toStatus}`);
  }

  const setClauses = ['status=$1', 'updated_at=NOW()'];
  const values = [toStatus];
  let p = 2;
  for (const [column, value] of Object.entries(extraFields)) {
    if (value === 'NOW()') {
      setClauses.push(`${column}=NOW()`);
    } else {
      setClauses.push(`${column}=$${p++}`);
      values.push(value);
    }
  }
  values.push(missionId, fromStatus);
  const whereClauses = [`id=$${p++}`, `status=$${p++}`];
  for (const [column, value] of Object.entries(extraGuards)) {
    whereClauses.push(`${column}=$${p++}`);
    values.push(value);
  }

  const { rows: [updated] } = await db.query(
    `UPDATE missions SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')} RETURNING *`,
    values
  );

  if (!updated) {
    throw new MissionTransitionError('STALE_STATE', 'Cette mission a changé de statut entre-temps, veuillez rafraîchir.');
  }

  await logStatus(db, missionId, toStatus, actor, note);

  return updated;
}

module.exports = { TRANSITIONS, isTransitionAllowed, transitionMission, MissionTransitionError };
