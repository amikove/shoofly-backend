const { getSetting } = require('../utils/settings');
const { sendEmailRaw } = require('../services/email');

// PROMPT 5 point 6 (2026-08-18) — extrait dans son propre module, même raison que
// jobs/autoValidateMissions.js : testable indépendamment. Deux flux à délai de réponse court
// (10-15min), où un WhatsApp non lu à temps fait perdre l'opportunité : la cascade candidat
// (mission_interests.solicited_at, advanceCandidateCascade) et la confirmation de présence H-45
// (missions.presence_confirmation_h45_email_sent_at). "Non lu" = la notification in-app
// correspondante (même title_key que celle posée par le déclencheur d'origine) a is_read=false —
// la lecture se fait normalement en ouvrant le panneau de notifications (Topbar.jsx), donc ce
// signal reflète fidèlement si le destinataire a effectivement vu l'alerte, peu importe le canal.
async function runUnreadWhatsappEmailFallback(db) {
  const fallbackMinutes = await getSetting(db, 'unread_whatsapp_email_fallback_minutes', 5);

  // 1) Cascade candidat (~10min) — Œil sollicité, jamais confirmé/refusé, fenêtre du lot
  // encore ouverte, notification de sollicitation toujours non lue.
  const { rows: candidateRows } = await db.query(`
    SELECT mi.oeil_id, mi.mission_id, m.title, u.email, u.first_name
    FROM mission_interests mi
    JOIN missions m ON m.id = mi.mission_id
    JOIN users u ON u.id = mi.oeil_id
    WHERE mi.solicited_at IS NOT NULL AND mi.confirmed_at IS NULL AND mi.declined = false
      AND mi.email_fallback_sent_at IS NULL
      AND mi.solicited_at <= NOW() - INTERVAL '1 minute' * $1::numeric
      AND m.status = 'pending'
      AND m.candidate_window_ends_at IS NOT NULL AND m.candidate_window_ends_at > NOW()
      AND EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.mission_id = mi.mission_id AND n.user_id = mi.oeil_id
          AND n.title_key = 'candidateConfirmRequestTitle' AND n.is_read = false
      )
  `, [fallbackMinutes]);

  const confirmationMinutes = await getSetting(db, 'candidate_confirmation_minutes', 10);
  for (const row of candidateRows) {
    try {
      const { rowCount } = await db.query(
        `UPDATE mission_interests SET email_fallback_sent_at=NOW() WHERE mission_id=$1 AND oeil_id=$2 AND email_fallback_sent_at IS NULL`,
        [row.mission_id, row.oeil_id]
      );
      if (rowCount === 0) continue;
      if (!row.email || !row.email.trim()) {
        console.warn(`[email] Relance cascade candidat ignorée — Œil ${row.oeil_id} sans email renseigné (mission ${row.mission_id})`);
        continue;
      }
      const greeting = row.first_name ? `Bonjour ${row.first_name},` : 'Bonjour,';
      await sendEmailRaw(
        row.email,
        `Confirmez votre disponibilité — "${row.title}"`,
        `<p>${greeting}</p><p>Vous êtes parmi les candidats les mieux classés pour la mission "${row.title}". Vous avez ${confirmationMinutes} minutes pour confirmer votre disponibilité dans l'application SHOOFLY, sinon un autre candidat sera sollicité à votre place.</p>`,
        `${greeting}\n\nVous êtes parmi les candidats les mieux classés pour la mission "${row.title}". Vous avez ${confirmationMinutes} minutes pour confirmer votre disponibilité dans l'application SHOOFLY, sinon un autre candidat sera sollicité à votre place.`
      );
      console.log(`📧 Relance email cascade candidat — mission ${row.mission_id}, Œil ${row.oeil_id}`);
    } catch (e) {
      console.error(`❌ Relance email cascade candidat (mission ${row.mission_id}) error:`, e.message);
    }
  }

  // 2) Confirmation de présence H-45 — Œil assigné, deadline pas encore expirée, notification
  // de ce palier précis toujours non lue.
  const { rows: h45Rows } = await db.query(`
    SELECT m.id AS mission_id, m.title, u.email, u.first_name, m.presence_confirmation_deadline_at
    FROM missions m
    JOIN users u ON u.id = m.oeil_id
    WHERE m.status = 'assigned'
      AND m.presence_confirmation_requested_at IS NOT NULL
      AND m.presence_confirmed_at IS NULL
      AND m.presence_confirmation_h45_email_sent_at IS NULL
      AND m.presence_confirmation_requested_at <= NOW() - INTERVAL '1 minute' * $1::numeric
      AND m.presence_confirmation_deadline_at IS NOT NULL AND m.presence_confirmation_deadline_at > NOW()
      AND EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.mission_id = m.id AND n.user_id = m.oeil_id
          AND n.title_key = 'presenceConfirmationRequestH45Title' AND n.is_read = false
      )
  `, [fallbackMinutes]);

  for (const row of h45Rows) {
    try {
      const { rowCount } = await db.query(
        `UPDATE missions SET presence_confirmation_h45_email_sent_at=NOW() WHERE id=$1 AND presence_confirmation_h45_email_sent_at IS NULL`,
        [row.mission_id]
      );
      if (rowCount === 0) continue;
      if (!row.email || !row.email.trim()) {
        console.warn(`[email] Relance confirmation H-45 ignorée — Œil sans email renseigné (mission ${row.mission_id})`);
        continue;
      }
      const deadlineTime = new Date(row.presence_confirmation_deadline_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Casablanca' });
      const greeting = row.first_name ? `Bonjour ${row.first_name},` : 'Bonjour,';
      await sendEmailRaw(
        row.email,
        `Confirmez votre présence — "${row.title}"`,
        `<p>${greeting}</p><p>Votre mission "${row.title}" approche. Merci de confirmer votre présence dans l'application SHOOFLY avant ${deadlineTime}, sinon un remplaçant sera recherché en urgence.</p>`,
        `${greeting}\n\nVotre mission "${row.title}" approche. Merci de confirmer votre présence dans l'application SHOOFLY avant ${deadlineTime}, sinon un remplaçant sera recherché en urgence.`
      );
      console.log(`📧 Relance email confirmation H-45 — mission ${row.mission_id}`);
    } catch (e) {
      console.error(`❌ Relance email confirmation H-45 (mission ${row.mission_id}) error:`, e.message);
    }
  }
}

module.exports = { runUnreadWhatsappEmailFallback };
