const { getSetting } = require('../utils/settings');
const { notify } = require('../routes/missions');
const { sendWhatsAppTemplate } = require('../services/wasel');
const waselTemplates = require('../config/waselTemplates');

// PROMPT 5 point 5 (2026-08-18) — extrait dans son propre module, même raison que
// jobs/autoValidateMissions.js : testable indépendamment (appel direct de la fonction, sans
// attendre un vrai tick cron toutes les 5min) sans déclencher les effets de bord du require de
// index.js.
//
// Suite du déclencheur candidature_whatsapp_sent_at (cron "Seuil WhatsApp candidatures", index.js) :
// une fois la notification WhatsApp initiale envoyée, le client peut rester sans agir. Ce job
// renvoie le même type de WhatsApp toutes les candidature_relance_interval_minutes (1er envoi
// après candidature_relance_first_after_minutes), tant que la mission reste 'pending'. Dès que
// scheduled_at passe sous candidature_relance_imminent_threshold_minutes, le relais est pris par
// une alerte admin unique (onglet "Missions proches sans validation") au lieu d'un nouveau
// WhatsApp — plus la mission est proche, moins un nouveau message au client a de chances de
// suffire à temps.
async function runCandidatureRelance(db, emitToUser = null) {
  const firstAfterMinutes = await getSetting(db, 'candidature_relance_first_after_minutes', 60);
  const intervalMinutes = await getSetting(db, 'candidature_relance_interval_minutes', 120);
  const imminentThresholdMinutes = await getSetting(db, 'candidature_relance_imminent_threshold_minutes', 120);

  const { rows: dueMissions } = await db.query(`
    SELECT m.id, m.title, m.scheduled_at, m.candidature_relance_count, c.phone AS client_phone,
      (SELECT COUNT(*)::int FROM mission_interests mi WHERE mi.mission_id = m.id) AS n
    FROM missions m
    JOIN users c ON c.id = m.client_id
    WHERE m.status = 'pending'
      AND m.candidature_whatsapp_sent_at IS NOT NULL
      AND m.candidature_admin_alert_sent_at IS NULL
      AND (
        (m.candidature_relance_count = 0 AND m.candidature_whatsapp_sent_at <= NOW() - INTERVAL '1 minute' * $1::numeric)
        OR
        (m.candidature_relance_count > 0 AND m.candidature_relance_last_sent_at <= NOW() - INTERVAL '1 minute' * $2::numeric)
      )
  `, [firstAfterMinutes, intervalMinutes]);

  for (const m of dueMissions) {
    try {
      const minutesToScheduled = (new Date(m.scheduled_at).getTime() - Date.now()) / 60000;

      if (minutesToScheduled < imminentThresholdMinutes) {
        // Mission trop proche pour compter sur un nouveau WhatsApp — bascule en alerte admin,
        // posée une seule fois (garde atomique WHERE ... IS NULL, sert aussi de filtre à la
        // liste GET /missions/admin/missions-proches-validation).
        const { rowCount } = await db.query(
          `UPDATE missions SET candidature_admin_alert_sent_at=NOW() WHERE id=$1 AND candidature_admin_alert_sent_at IS NULL`,
          [m.id]
        );
        if (rowCount === 0) continue;

        const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
        for (const admin of admins) {
          await notify(db, admin.id, '⏰ Mission proche sans candidature validée',
            `"${m.title}" est prévue bientôt et le client n'a toujours pas choisi d'Œil parmi ${m.n} candidature(s) reçues.`,
            'warning', m.id, emitToUser, 'admin_missions_proches_validation',
            'candidatureAdminAlertTitle', 'candidatureAdminAlertBody', { missionTitle: m.title, count: m.n });
        }
        console.log(`⏰ Alerte admin — mission ${m.id} proche sans candidature validée (${m.n} candidature(s))`);
      } else {
        const { rowCount } = await db.query(
          `UPDATE missions SET candidature_relance_count = candidature_relance_count + 1, candidature_relance_last_sent_at = NOW() WHERE id=$1`,
          [m.id]
        );
        if (rowCount > 0 && m.client_phone) {
          await sendWhatsAppTemplate(waselTemplates.candidature_relance_client.template_name, m.client_phone, [String(m.n), m.title]);
          console.log(`📲 Relance WhatsApp candidatures — mission ${m.id} (#${m.candidature_relance_count + 1}, ${m.n} candidature(s))`);
        }
      }
    } catch (e) {
      console.error(`❌ Relance candidatures mission ${m.id} error:`, e.message);
    }
  }
}

module.exports = { runCandidatureRelance };
