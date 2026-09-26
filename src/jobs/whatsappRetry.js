const Sentry = require('@sentry/node');
const { getSetting } = require('../utils/settings');
const { sendWhatsAppTemplateRaw } = require('../services/wasel');
const { withTransaction } = require('../services/walletService');

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
//
// SC-6 (audit scalabilité 2026-09-26) — sûr à 2 processus (2 instances, ou chevauchement de
// déploiement Render où les 2 processus tiquent au même instant). Avant : SELECT de tous les échecs
// puis envoi, sans réservation → les deux processus renvoyaient les mêmes messages.
// Désormais :
//  - la liste du tick est bornée (LIMIT) et mémorise le retry_count vu ;
//  - chaque ligne est RÉSERVÉE avant l'envoi par SELECT … FOR UPDATE SKIP LOCKED, dans une
//    transaction courte PAR LIGNE (un seul envoi, borné par le timeout Wasel de 10 s, pendant qu'elle
//    est tenue — exception assumée à la règle « pas d'appel externe en transaction » : c'est le verrou
//    lui-même qui empêche l'autre processus d'envoyer en même temps) ;
//  - la réservation exige encore retry_count = valeur vue : une ligne déjà retentée par l'autre
//    processus pendant ce tick (verrou relâché, compteur incrémenté) est sautée, pas renvoyée.
// Une transaction par ligne (et non une pour tout le lot) : un arrêt brutal au milieu du lot
// n'annule pas le résultat des envois déjà faits (sinon ils seraient renvoyés au tick suivant).
const RETRY_BATCH_LIMIT = 50;

async function runWhatsAppRetry(db) {
  const maxAttempts = await getSetting(db, 'whatsapp_retry_max_attempts', 3);
  const { rows: candidates } = await db.query(
    `SELECT id, retry_count FROM whatsapp_send_failures
     WHERE resolved_at IS NULL AND retry_count < $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [maxAttempts, RETRY_BATCH_LIMIT]
  );

  for (const candidate of candidates) {
    try {
      await withTransaction(db, async (client) => {
        const { rows: [failure] } = await client.query(
          `SELECT id, template_name, phone, variables FROM whatsapp_send_failures
           WHERE id = $1 AND resolved_at IS NULL AND retry_count = $2
           FOR UPDATE SKIP LOCKED`,
          [candidate.id, candidate.retry_count]
        );
        if (!failure) return; // réservée ou déjà traitée par un autre processus

        const result = await sendWhatsAppTemplateRaw(failure.template_name, failure.phone, failure.variables);
        if (result.ok) {
          await client.query(
            `UPDATE whatsapp_send_failures SET retry_count = retry_count + 1, resolved_at = NOW() WHERE id = $1`,
            [failure.id]
          );
          console.log(`✅ Retry WhatsApp réussi (échec #${failure.id}, template="${failure.template_name}")`);
        } else {
          await client.query(
            `UPDATE whatsapp_send_failures SET retry_count = retry_count + 1, error_message = $2 WHERE id = $1`,
            [failure.id, result.errorMessage || 'Échec (raison inconnue)']
          );
        }
      });
    } catch (e) {
      console.error(`❌ Retry WhatsApp échec #${candidate.id} error:`, e.message);
    }
  }

  await checkWhatsAppHealth(db);
}

module.exports = { runWhatsAppRetry };
