const { getSetting } = require('../utils/settings');
const { logStatus } = require('../utils/missionHistory');
const walletService = require('../services/walletService');
const { settleCashCommission } = require('../utils/cashCommission');
// notify() vient de routes/missions.js — require sûr ici (missions.js ne require jamais ce
// module en retour, pas de cycle) : évite de dupliquer l'INSERT INTO notifications + emitToUser
// déjà standardisé ailleurs dans le projet.
const { notify } = require('../routes/missions');

// Job horaire (appelé depuis index.js via cron) — valide et paie automatiquement
// les missions restées 'completed' sans réponse du client au-delà du délai configuré
// (client_validation_hours). Variante automatique de POST /missions/:id/validate :
// même logique de split au prorata sur une chaîne de transfert, même atomicité.
// Extrait dans son propre module (plutôt que défini inline dans index.js) pour être
// testable indépendamment, sans déclencher les effets de bord du require de index.js
// (démarrage serveur, écoute du port, enregistrement de tous les autres crons).
//
// PROMPT 5 (2026-08-18) — cette validation était jusqu'ici totalement silencieuse (aucune
// notification, seul un console.log serveur en traçait le passage) : emitToUser optionnel
// (comme partout ailleurs dans le projet — un stub de test peut l'omettre), utilisé pour
// notifier client ET Œil une fois le paiement effectivement appliqué.
async function runAutoValidateMissions(db, emitToUser = null) {
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
    //
    // Notifications toujours APRÈS le commit (même règle que POST /:id/validate) : jamais de
    // notify()/emitToUser dans la transaction, pour ne jamais pousser une notif "vous avez été
    // payé" côté client si l'écriture wallet est ensuite annulée par un rollback plus loin dans
    // le bloc. partialPayments/cashSettlement rejouent exactement le même schéma que la route
    // manuelle pour rester cohérents avec elle.
    let validated = false;
    const partialPayments = [];
    let cashSettlement = null;
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
        validated = true;

        if (mission.payment_method === 'payzone') {
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
                partialPayments.push({ oeilId: link.oeil_id, share });
              }
            } else {
              await walletService.credit(client, mission.oeil_id, 'oeil', mission.oeil_earning, 'Validation automatique après délai (paiement intégral)', mission.id);
            }
          } else {
            await walletService.credit(client, mission.oeil_id, 'oeil', mission.oeil_earning, 'Validation automatique après délai', mission.id);
          }
        } else {
          // Mission cash (2026-08-13) — voir routes/missions.js POST /:id/validate pour la même
          // logique et sa justification détaillée (débit de mission.oeil_id, pas de split par
          // chaîne pour la commission).
          if (mission.transfer_type === 'during') {
            await client.query(`UPDATE mission_transfer_chain SET ended_at=NOW() WHERE mission_id=$1 AND ended_at IS NULL`, [mission.id]);
          }
          cashSettlement = await settleCashCommission(client, mission, 'Commission Shoofly — mission cash (validation automatique après délai)');
        }

        await logStatus(client, mission.id, 'completed', null, 'Validation automatique après délai sans réponse du client');
      });
    } catch (e) {
      console.error(`❌ Auto-validation mission ${mission.id} error:`, e.message);
      continue;
    }
    if (!validated) continue;

    // PROMPT 5 (2026-08-18) — notification in-app client + Œil, absente jusqu'ici (seul un
    // console.log serveur traçait le passage). Échec de notification n'annule jamais le
    // paiement déjà commité — capturé séparément du try/catch de la transaction ci-dessus.
    try {
      for (const p of partialPayments) {
        await notify(db, p.oeilId, '💰 Paiement partiel reçu (automatique)',
          `${p.share} MAD crédités — votre part de "${mission.title}" (validation automatique après délai).`,
          'info', mission.id, emitToUser, null, 'partialPaymentAutoReceivedTitle', 'partialPaymentAutoReceivedBody',
          { amount: p.share, missionTitle: mission.title });
      }
      if (cashSettlement) {
        await notify(db, mission.oeil_id, '✅ Mission validée automatiquement',
          `Validation automatique après délai pour "${mission.title}". ${cashSettlement.collected} MAD de commission débités de votre wallet (mission cash).`,
          'info', mission.id, emitToUser, null, 'autoValidatedCashOeilTitle', 'autoValidatedCashOeilBody',
          { missionTitle: mission.title, amount: cashSettlement.collected });
      } else if (partialPayments.length === 0) {
        await notify(db, mission.oeil_id, '💰 Paiement reçu (automatique)',
          `Validation automatique après délai pour "${mission.title}". ${mission.oeil_earning} MAD crédités.`,
          'info', mission.id, emitToUser, null, 'autoValidatedOeilTitle', 'autoValidatedOeilBody',
          { missionTitle: mission.title, amount: mission.oeil_earning });
      }
      await notify(db, mission.client_id, '✅ Mission validée automatiquement',
        `"${mission.title}" a été validée automatiquement après ${clientValidationHours}h sans réponse de votre part.`,
        'info', mission.id, emitToUser, null, 'autoValidatedClientTitle', 'autoValidatedClientBody',
        { missionTitle: mission.title, hours: clientValidationHours });
    } catch (e) {
      console.error(`❌ Notification auto-validation mission ${mission.id} error:`, e.message);
    }
    console.log(`✅ Auto-validé mission ${mission.id}`);
  }
}

// PROMPT 5 (2026-08-18) — rappel intermédiaire client à client_validation_reminder_hours (H+6
// par défaut) dans la fenêtre de client_validation_hours (12h) : le client n'a aujourd'hui aucun
// signal entre la clôture par l'Œil et soit sa propre action, soit l'auto-validation silencieuse
// à 12h. Même table/mêmes colonnes que runAutoValidateMissions ci-dessus, mais sélection et effet
// disjoints (un simple rappel, jamais de paiement) — fonction séparée plutôt qu'une branche de
// plus dans la boucle déjà dense ci-dessus.
async function runValidationReminders(db, emitToUser = null) {
  const clientValidationHours = await getSetting(db, 'client_validation_hours', 12);
  const reminderHours = await getSetting(db, 'client_validation_reminder_hours', 6);
  const { rows: missions } = await db.query(`
    SELECT * FROM missions
    WHERE status='completed'
      AND completed_by_oeil_at IS NOT NULL
      AND completed_by_oeil_at < NOW() - INTERVAL '1 hour' * $1::numeric
      AND completed_by_oeil_at >= NOW() - INTERVAL '1 hour' * $2::numeric
      AND validated_at IS NULL
      AND validation_reminder_sent_at IS NULL
  `, [reminderHours, clientValidationHours]);

  for (const mission of missions) {
    try {
      // Garde atomique — même mission ne peut pas être rappelée deux fois si deux ticks se
      // chevauchaient (verrou cronXxxRunning côté index.js protège déjà contre ça, ceinture et
      // bretelles).
      const { rowCount } = await db.query(
        `UPDATE missions SET validation_reminder_sent_at=NOW() WHERE id=$1 AND validation_reminder_sent_at IS NULL`,
        [mission.id]
      );
      if (rowCount === 0) continue;

      const hoursLeft = Math.max(0, Math.round(clientValidationHours - reminderHours));
      await notify(db, mission.client_id, '⏳ Mission à valider',
        `Votre mission "${mission.title}" est terminée et en attente de votre validation. Sans action de votre part, elle sera validée automatiquement dans environ ${hoursLeft}h.`,
        'warning', mission.id, emitToUser, 'mission_view', 'validationReminderH6Title', 'validationReminderH6Body',
        { missionTitle: mission.title, hoursLeft });
      console.log(`⏳ Rappel validation (H+${reminderHours}) envoyé — mission ${mission.id}`);
    } catch (e) {
      console.error(`❌ Rappel validation mission ${mission.id} error:`, e.message);
    }
  }
}

module.exports = { runAutoValidateMissions, runValidationReminders };
