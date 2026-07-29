const { getSetting } = require('../utils/settings');
const { sendWhatsAppTemplateRaw } = require('../services/wasel');

// Job périodique (appelé depuis index.js via cron) — reprend les échecs d'envoi WhatsApp non
// résolus (whatsapp_send_failures.resolved_at IS NULL) et retente sendWhatsAppTemplateRaw
// directement (jamais sendWhatsAppTemplate : celle-ci créerait une NOUVELLE ligne d'échec à
// chaque retentative ratée au lieu de faire progresser retry_count sur la ligne existante).
// Extrait dans son propre module (même raison que runAutoValidateMissions) — testable
// indépendamment, sans déclencher les effets de bord du require de index.js.
async function runWhatsAppRetry(db) {
  const maxAttempts = await getSetting(db, 'whatsapp_retry_max_attempts', 3);
  const { rows: failures } = await db.query(
    `SELECT id, template_name, phone, variables FROM whatsapp_send_failures
     WHERE resolved_at IS NULL AND retry_count < $1
     ORDER BY created_at ASC`,
    [maxAttempts]
  );

  for (const failure of failures) {
    try {
      const result = await sendWhatsAppTemplateRaw(failure.template_name, failure.phone, failure.variables);
      if (result.ok) {
        await db.query(
          `UPDATE whatsapp_send_failures SET retry_count = retry_count + 1, resolved_at = NOW() WHERE id = $1`,
          [failure.id]
        );
        console.log(`✅ Retry WhatsApp réussi (échec #${failure.id}, template="${failure.template_name}")`);
      } else {
        await db.query(
          `UPDATE whatsapp_send_failures SET retry_count = retry_count + 1, error_message = $2 WHERE id = $1`,
          [failure.id, result.errorMessage || 'Échec (raison inconnue)']
        );
      }
    } catch (e) {
      console.error(`❌ Retry WhatsApp échec #${failure.id} error:`, e.message);
    }
  }
}

module.exports = { runWhatsAppRetry };
