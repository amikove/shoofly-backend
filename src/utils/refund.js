const { getSetting } = require('./settings');

// Remboursement client suite à l'annulation d'une mission.
//
// La règle de timing (100% avant assignation, 50% si annulation >2h avant la
// mission après assignation, 0% si <2h avant) n'a de sens que si l'annulation
// est à l'initiative du client (il change d'avis). Si l'annulation est causée
// par l'Œil, le système (cron) ou une décision admin non imputable au client,
// celui-ci n'a rien à se reprocher et doit être remboursé intégralement, peu
// importe le timing.
async function refundOnCancellation(db, mission, initiatedByClient, reasonOverride = null) {
  let refund = 0;
  let reason = null;

  if (initiatedByClient) {
    if (!mission.oeil_id) {
      // Annulation avant assignation → remboursement intégral
      refund = mission.price;
      reason = 'Remboursement annulation avant assignation';
    } else {
      const partialThresholdHours = await getSetting(db, 'refund_partial_threshold_hours', 2);
      const partialRate = await getSetting(db, 'refund_partial_rate', 0.5);
      const hoursBeforeMission = (new Date(mission.scheduled_at).getTime() - Date.now()) / 3600000;
      if (hoursBeforeMission > partialThresholdHours) {
        refund = Math.round(mission.price * partialRate * 100) / 100;
        reason = `Remboursement annulation (${Math.round(partialRate * 100)}%)`;
      }
      // < seuil avant la mission : aucun remboursement
    }
  } else {
    // Annulation non imputable au client (Œil, système/cron, admin) → remboursement intégral systématique
    refund = mission.price;
    reason = 'Remboursement intégral — annulation non imputable au client';
  }

  if (refund > 0) {
    await db.query(`UPDATE users SET balance=balance+$1 WHERE id=$2`, [refund, mission.client_id]);
    await db.query(
      `INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,$3,$4)`,
      [mission.client_id, refund, reasonOverride || reason, mission.id]
    );
  }

  return refund;
}

module.exports = { refundOnCancellation };
