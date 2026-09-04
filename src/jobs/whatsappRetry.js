const Sentry = require('@sentry/node');
const { getSetting } = require('../utils/settings');
const { sendWhatsAppTemplateRaw } = require('../services/wasel');

// Seuil d'alerte de santé WhatsApp (voir checkWhatsAppHealth ci-dessous) — nombre d'échecs
// distincts encore non résolus sur la dernière heure au-delà duquel on suspecte une panne
// systémique (ex. compte Wasel/Meta rejetant tous les envois) plutôt que des échecs isolés
// (mauvais numéro d'un utilisateur donné, etc). Env var plutôt que réglage
// `settings` (même convention que SOCKET_REVALIDATION_INTERVAL_MS, index.js) : seuil
// d'observabilité interne, pas un paramètre métier à exposer aux admins dans Paramètres.
// Défaut = 3, aligné sur whatsapp_retry_max_attempts (même ordre de grandeur "3 coups" déjà
// utilisé pour ce sous-système) : assez bas pour détecter une panne en ~1h même au faible
// volume pré-lancement, assez haut pour ne pas alerter sur 1-2 échecs isolés (numéro invalide).
const HEALTH_ALERT_THRESHOLD = parseInt(process.env.WHATSAPP_HEALTH_ALERT_THRESHOLD) || 3;

// Vérification de santé indépendante du canal WhatsApp lui-même (l'alerte part par Sentry →
// email, jamais par WhatsApp — sinon une panne WhatsApp empêcherait sa propre alerte). Ne
// compte QUE les échecs encore non résolus après cette tentative de retry (resolved_at IS
// NULL) : un échec ponctuel qui a fini par réussir au retry n'est pas un signal de panne.
// Fingerprint fixe : Sentry regroupe tous les appels sous UN SEUL issue tant qu'il reste
// ouvert (peu importe le nombre d'échecs exact, qui varie à chaque tick) — un tick recyclé de
// 15 minutes pendant une panne en cours n'envoie donc pas une notification par tick, seul le
// premier événement d'un issue (re)ouvert déclenche l'alerte email Sentry par défaut.
async function checkWhatsAppHealth(db) {
  try {
    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM whatsapp_send_failures
       WHERE resolved_at IS NULL AND created_at > NOW() - INTERVAL '1 hour'`
    );
    if (count >= HEALTH_ALERT_THRESHOLD) {
      console.error(`🚨 Alerte santé WhatsApp : ${count} échecs non résolus sur la dernière heure (seuil=${HEALTH_ALERT_THRESHOLD})`);
      Sentry.captureMessage(
        `WhatsApp — ${count} échecs d'envoi non résolus sur la dernière heure (seuil ${HEALTH_ALERT_THRESHOLD})`,
        { level: 'error', fingerprint: ['whatsapp-health-alert'], tags: { alert: 'whatsapp_health' } }
      );
    }
  } catch (e) {
    console.error('❌ Vérification santé WhatsApp error:', e.message);
  }
}

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

  await checkWhatsAppHealth(db);
}

module.exports = { runWhatsAppRetry };
