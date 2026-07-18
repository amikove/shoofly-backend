const { getSetting } = require('../utils/settings');
const { logStatus } = require('../utils/missionHistory');
const walletService = require('../services/walletService');

// Job horaire (appelé depuis index.js via cron) — valide et paie automatiquement
// les missions restées 'completed' sans réponse du client au-delà du délai configuré
// (client_validation_hours). Variante automatique de POST /missions/:id/validate :
// même logique de split au prorata sur une chaîne de transfert, même atomicité.
// Extrait dans son propre module (plutôt que défini inline dans index.js) pour être
// testable indépendamment, sans déclencher les effets de bord du require de index.js
// (démarrage serveur, écoute du port, enregistrement de tous les autres crons).
async function runAutoValidateMissions(db) {
  const clientValidationHours = await getSetting(db, 'client_validation_hours', 12);
  const { rows: missions } = await db.query(`
    SELECT * FROM missions
    WHERE status='completed'
      AND completed_by_oeil_at IS NOT NULL
      AND completed_by_oeil_at < NOW() - INTERVAL '1 hour' * $1::numeric
      AND validated_at IS NULL
  `, [clientValidationHours]);

  for (const mission of missions) {
    // Le statut a pu changer entre le SELECT et ici (ex: réclamation déposée
    // entre-temps) — la garde sur le WHERE évite de payer une mission qui n'est
    // plus 'completed'. Toutes les écritures dans une seule transaction : un crash
    // entre validated_at et le crédit ne doit jamais laisser une mission "validée"
    // sans paiement appliqué.
    try {
      await walletService.withTransaction(db, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE missions SET validated_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='completed' AND validated_at IS NULL`,
          [mission.id]
        );
        if (rowCount === 0) {
          console.log(`ℹ️ Auto-validation ignorée pour mission ${mission.id} : statut a changé entre-temps`);
          return;
        }

        if (mission.transfer_type === 'during') {
          await client.query(`UPDATE mission_transfer_chain SET ended_at=NOW() WHERE mission_id=$1 AND ended_at IS NULL`, [mission.id]);
          const { rows: chain } = await client.query(
            `SELECT oeil_id, started_at, ended_at FROM mission_transfer_chain WHERE mission_id=$1 ORDER BY sequence_order ASC`,
            [mission.id]
          );
          if (chain.length > 0) {
            const durations = chain.map(c => Math.max(0, new Date(c.ended_at) - new Date(c.started_at)));
            const totalDuration = durations.reduce((s, d) => s + d, 0);
            for (let i = 0; i < chain.length; i++) {
              const link = chain[i];
              const share = totalDuration > 0
                ? Math.round(mission.oeil_earning * (durations[i] / totalDuration) * 100) / 100
                : Math.round((mission.oeil_earning / chain.length) * 100) / 100;
              await client.query(`UPDATE mission_transfer_chain SET earning_share=$1 WHERE mission_id=$2 AND oeil_id=$3`, [share, mission.id, link.oeil_id]);
              await walletService.credit(client, link.oeil_id, 'oeil', share, 'Part mission — transfert au prorata (validation automatique)', mission.id);
            }
          } else {
            await walletService.credit(client, mission.oeil_id, 'oeil', mission.oeil_earning, 'Validation automatique après délai (paiement intégral)', mission.id);
          }
        } else {
          await walletService.credit(client, mission.oeil_id, 'oeil', mission.oeil_earning, 'Validation automatique après délai', mission.id);
        }

        await logStatus(client, mission.id, 'completed', null, 'Validation automatique après délai sans réponse du client');
      });
      console.log(`✅ Auto-validé mission ${mission.id}`);
    } catch (e) {
      console.error(`❌ Auto-validation mission ${mission.id} error:`, e.message);
    }
  }
}

module.exports = { runAutoValidateMissions };
