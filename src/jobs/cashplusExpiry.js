// Marque expired les demandes de recharge CashPlus jamais confirmées par callback — voir
// schema.js (cashplus_recharge_requests) et RECAP_INTEGRATION_CASHPLUS.md §5. Cron dédié
// (index.js, */5 * * * *) plutôt que calcul à la volée à la lecture — même convention que
// checkTransferDeadlines/checkMissionEditRequestExpiry/checkAssistanceRequestExpiry (routes/
// missions.js) : un statut stocké et interrogeable reste correct même si personne ne relit la
// ligne avant longtemps, contrairement à un statut dérivé qu'il faudrait recalculer à chaque
// lecture. Extrait dans son propre module — même raison que jobs/walletReconciliation.js :
// testable indépendamment, sans déclencher les effets de bord du require de index.js.
//
// Aucune action financière ici (pas de pénalité) : un token simplement expiré n'a jamais
// crédité le wallet (walletService.credit() n'est appelé QUE par le callback, routes/
// payments.js — jamais ici), donc rien à défaire. Un callback HMAC-valide arrivant APRÈS ce
// passage en 'expired' reste honoré normalement (voir routes/payments.js) : ce cron ne fait
// qu'une hypothèse optimiste en l'absence de callback, jamais une décision définitive.
//
// Chantier notifications (2026-09-14), Partie C/G1 — jusqu'ici totalement silencieux (seul le
// console.log ci-dessous en traçait le passage) : l'Œil n'avait aucun signal ("en attente",
// "expiré", "réessayez"). notify() simple par Œil concerné, emitToUser optionnel (comme partout
// ailleurs dans le projet, voir jobs/walletReconciliation.js).
const { notify } = require('../utils/notify');

async function runCashplusExpiry(db, emitToUser = null) {
  const { rows } = await db.query(`
    UPDATE cashplus_recharge_requests
    SET status='expired'
    WHERE status='pending' AND date_expiration < NOW()
    RETURNING id, request_id, oeil_id, amount
  `);
  if (rows.length) {
    console.log(`⏳ CashPlus — ${rows.length} demande(s) de recharge expirée(s)`);
    for (const r of rows) {
      try {
        await notify(db, r.oeil_id, '⏳ Recharge CashPlus expirée',
          `Votre demande de recharge de ${r.amount} MAD a expiré sans confirmation. Vous pouvez réessayer.`,
          'warning', null, emitToUser, null,
          'cashplusExpiredOeilTitle', 'cashplusExpiredOeilBody', { amount: r.amount });
      } catch (e) { console.error(`❌ Notification expiration CashPlus ${r.id} error:`, e.message); }
    }
  }
  return rows;
}

module.exports = { runCashplusExpiry };
