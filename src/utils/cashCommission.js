const walletService = require('../services/walletService');

// ── Modèle de paiement cash (2026-08-13) — voir RAPPORT_DIAGNOSTIC_COHERENCE_CASH_VS_PAYZONE.md
// et schema.js (missions.payment_method, mission_commission_shortfalls). Ce module ne contient
// QUE la logique spécifique à payment_method='cash' — jamais exécuté ni importé par un chemin
// payzone, pour garantir que ce dernier reste identique au bit près (garde-fou explicite de la
// session).

// ── Vérification d'affectation — mission cash uniquement ──────────────────
// Même contrat que checkOeilAssignable (utils/oeilAssignment.js) — {error, code} si bloqué,
// {ok:true} sinon — mais délibérément gardée dans son propre module plutôt qu'ajoutée à LA
// famille checkOeilAssignable : zéro risque de régression sur ce chemin déjà exercé par ses 4
// appelants existants (prepareMissionInsert, POST /:id/accept, hireOeilCore, assign-admin) et par
// l'audit E2E qui le couvre. Appelée EN PLUS de checkOeilAssignable, jamais à sa place, uniquement
// quand mission.payment_method==='cash' — n'exécute donc jamais rien pour 'payzone'.
//
// Lecture seule, non verrouillée (SELECT simple, pas de FOR UPDATE) — comme les autres contrôles
// de la famille checkOeilAssignable, c'est un contrôle d'ÉLIGIBILITÉ au moment de l'affectation,
// pas une réservation de fonds : le montant réellement prélevé est décidé séparément à la
// validation (voir settleCashCommission ci-dessous), qui peut constater un solde différent — le
// solde peut se dégrader entre affectation et validation (décision produit : accepté, jamais
// bloquant à ce stade tardif, voir settleCashCommission).
async function checkCashCommissionBalance(db, oeilId, commission) {
  const amount = parseFloat(commission) || 0;
  if (amount <= 0) return { ok: true }; // rien à couvrir (mission gratuite / promo)

  const { rows: [row] } = await db.query(`SELECT balance FROM oeil_profiles WHERE user_id=$1`, [oeilId]);
  if (!row) return { error: 'Œil introuvable', code: 'not_found' };

  const balance = parseFloat(row.balance);
  if (balance < amount) {
    return {
      error: `Solde wallet insuffisant pour couvrir la commission de cette mission cash (${amount.toFixed(2)} MAD requis, ${balance.toFixed(2)} MAD disponibles).`,
      code: 'insufficient_cash_commission_balance',
    };
  }
  return { ok: true };
}

// ── Règlement à la validation — mission cash uniquement ────────────────────
// Contrepartie cash de walletService.credit(client, mission.oeil_id, 'oeil', mission.oeil_earning,
// ...) : au lieu de créditer l'Œil (le client l'a déjà payé directement en espèces), débite la
// commission Shoofly de son wallet. Décision produit (session 2026-08-13, en réponse à un conflit
// structurel constaté entre "autoriser un solde négatif" et la contrainte CHECK(balance>=0) sur
// oeil_profiles — voir historique de session) : ce débit n'est JAMAIS bloquant et ne rend JAMAIS
// le solde négatif — il est plafonné au solde réellement disponible au moment de la validation
// (Math.min), et tout manque à gagner (commission due non entièrement collectée) est journalisé
// dans mission_commission_shortfalls pour rester visible côté admin (voir routes/users.js, GET/PUT
// .../admin/commission-shortfalls) plutôt que de rester invisible dans les seuls logs serveur.
//
// `client` : DOIT être un client de transaction déjà ouvert (walletService.withTransaction) —
// jamais le pool brut. lockBalance() l'exige (verrouille la ligne via FOR UPDATE, voir
// walletService.js) et tous les appelants actuels sont déjà dans une transaction pour ce même
// bloc d'écritures interdépendantes (validated_at, chaîne de transfert, crédit/débit, historique).
// Appelée exclusivement depuis l'intérieur des transactions de validation existantes : POST
// /:id/validate, POST /:id/assistance/respond, checkAssistanceRequestExpiry (routes/missions.js),
// runAutoValidateMissions (jobs/autoValidateMissions.js), PUT /admin/claims/:missionId/resolve
// (routes/users.js).
//
// Retourne { collected, shortfall } — collected est le montant réellement débité (0 si le solde
// était déjà à 0 ou négatif), shortfall la part non collectée (0 si le solde suffisait). Ne
// débite rien du tout si commission<=0 (mission gratuite/promo) — même filet que
// checkCashCommissionBalance ci-dessus.
async function settleCashCommission(client, mission, reason) {
  const commission = parseFloat(mission.commission) || 0;
  if (commission <= 0) return { collected: 0, shortfall: 0 };

  const currentBalance = await walletService.lockBalance(client, mission.oeil_id, 'oeil');
  const collected = Math.round(Math.min(commission, currentBalance || 0) * 100) / 100;
  if (collected > 0) {
    await walletService.debit(client, mission.oeil_id, 'oeil', collected, reason, mission.id);
  }

  const shortfall = Math.round((commission - collected) * 100) / 100;
  if (shortfall > 0) {
    await client.query(
      `INSERT INTO mission_commission_shortfalls (mission_id, oeil_id, commission_due, commission_collected, shortfall)
       VALUES ($1,$2,$3,$4,$5)`,
      [mission.id, mission.oeil_id, commission, collected, shortfall]
    );
  }

  return { collected, shortfall };
}

module.exports = { checkCashCommissionBalance, settleCashCommission };
