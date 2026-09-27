const crypto = require('crypto');
const webpush = require('web-push');
const Sentry = require('@sentry/node');
const { getDb } = require('../db/schema');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Canal de notification push — Web Push / VAPID (RFC 8291), miroir exact de services/wasel.js.
//   • Ne lève JAMAIS vers l'appelant — un échec push ne doit jamais faire échouer l'action
//     métier (embauche, transition de statut, cron…). Même contrat que sendWhatsAppTemplate.
//   • Ce module est un annuaire + un journal. AUCUNE logique d'escalade n'y vit : le « quand »,
//     le « quoi » et le « vers qui » restent dans notify() (utils/notify.js), les crons et les
//     réglages. Voir rapport-chantier-audit-notifications-matrice-2026-09-08.md §6.
//   • `web-push` = simple POST chiffré, aucune dépendance SaaS (pas de FCM/Firebase). Une seule
//     paire de clés VAPID en env, comme WASEL_API_KEY / RESEND_API_KEY.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// Configuration VAPID au chargement du module. Absente → le canal est simplement inerte
// (sendWebPush renvoie { skipped:true }), l'app démarre et fonctionne normalement — même
// tolérance que SENTRY_DSN / RESEND_API_KEY. Un try/catch garde le require lui-même contre une
// clé mal formée (ne doit jamais empêcher le boot).
let vapidConfigured = false;
try {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:contact@shoofly.ma', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    vapidConfigured = true;
  } else {
    console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY non configurées — canal push inerte (envois ignorés)');
  }
} catch (err) {
  console.error('[push] Configuration VAPID invalide — canal push inerte :', err.message);
}

function isPushConfigured() {
  return vapidConfigured;
}

// Seuil d'alerte de santé push — nombre d'échecs provider distincts sur la dernière heure
// au-delà duquel on suspecte une panne systémique. Env var plutôt que réglage `settings`
// (même convention que WHATSAPP_HEALTH_ALERT_THRESHOLD, jobs/whatsappRetry.js) : seuil
// d'observabilité interne, pas un paramètre métier. Défaut = 3.
const HEALTH_ALERT_THRESHOLD = parseInt(process.env.PUSH_HEALTH_ALERT_THRESHOLD) || 3;

// Deep-link d'une notification push → chemin relatif ouvert par le service worker
// (clients.openWindow). MIROIR du switch de shoofly-react/src/components/layout/Topbar.jsx
// (handleClick) : le clic sur un push doit atterrir au même endroit que le clic sur la
// notification in-app correspondante.
//   • action_type admin ou spécifiques Œil (gains, vérification) : non ambigus → chemin réel.
//   • action_type dépendant du rôle (chat / mission_view / ticket_view) : le SW n'a pas le rôle
//     sous la main, donc `ctx.role` est résolu en amont par notify() (lookup DB, uniquement pour
//     ces action_type — voir ROLE_AWARE_ACTION_TYPES) et transmis ici. `ctx.role` absent/inconnu
//     → repli sur '/' (comportement historique, jamais pire qu'avant ce correctif).
//   • correctif chantier "deep-link push" (2026-09-13) : mission_view/interests_modal/ticket_view
//     ouvraient tous '/' (générique) faute de case dédiée — ajout des 3 cases ci-dessous, mêmes
//     règles de sous-branchement que Topbar.jsx (title_key pour mission_view, params.ticketId
//     pour ticket_view). 'chat' était déjà absent lui aussi ; case ajoutée pour cohérence/prêt à
//     l'emploi, mais RESTE INATTEIGNABLE tant que les 2 sites d'appel bruts (index.js, chat
//     missions.js) ne sont pas migrés vers notify() — voir rapport de chantier §B, signalement.
function deepLinkFor(actionType, missionId = null, ctx = {}) {
  const { role = null, titleKey = null, params = null } = ctx;
  const missionsPath = role === 'oeil' ? '/oeil/missions' : role === 'client' ? '/client/missions' : null;
  switch (actionType) {
    case 'admin_missions':                     return '/admin/missions';
    case 'admin_problems':                     return '/admin/problemes';
    case 'admin_messages_suspects':            return '/admin/messages-suspects';
    case 'admin_fiabilite':                    return '/admin/fiabilite';
    case 'admin_wallet_reconciliation':        return '/admin/wallet-reconciliation';
    case 'admin_missions_proches_validation':  return '/admin/missions-proches-validation';
    case 'admin_urgent_ticket':
    case 'admin_ticket_message':
    case 'admin_new_ticket':                   return '/admin/tickets';
    case 'admin_block_appeals':                return '/admin/block-appeals';
    case 'gains_page':                         return '/oeil/gains';
    case 'verification_page':                  return '/oeil/verification-identite';
    case 'reliability_page':                   return '/oeil/compte';
    // Toujours envoyé à mission.client_id (routes/missions.js POST /:id/interest) : rôle fixe,
    // aucun lookup nécessaire.
    case 'interests_modal':
      return missionId ? `/client/missions?pending=interests_modal&missionId=${missionId}` : '/client/missions';
    case 'chat':
      if (!missionsPath) return '/';
      return missionId ? `${missionsPath}?pending=chat&missionId=${missionId}` : missionsPath;
    case 'mission_view': {
      if (!missionsPath) return '/';
      if (!missionId) return missionsPath;
      // Mêmes 2 title_key spéciaux que Topbar.jsx — tout autre title_key retombe sur la liste
      // (déjà correcte par rôle), exactement comme le clic in-app aujourd'hui.
      if (titleKey === 'assistanceMissionRequestClientTitle') return `/client/missions?pending=mission_detail&missionId=${missionId}`;
      if (titleKey === 'candidateConfirmRequestTitle') return `/oeil/missions?pending=candidate_confirm&missionId=${missionId}`;
      // Tout autre title_key : Topbar.jsx ne fait qu'un navigate(missionsRoute) sans setPending
      // (aucune modale/highlight dédiée n'existe côté in-app pour ces title_key) — parité stricte,
      // pas de query `pending` ici (rien à consommer côté frontend).
      return missionsPath;
    }
    case 'ticket_view': {
      const ticketsPath = role === 'oeil' ? '/oeil/tickets' : role === 'client' ? '/client/tickets' : null;
      if (!ticketsPath) return '/';
      const ticketId = params && params.ticketId;
      return ticketId ? `${ticketsPath}?openTicketId=${ticketId}` : ticketsPath;
    }
    // Miroir de useNotifications.js (frontend) — même branchement par rôle.
    case 'mes_signalements':
      return role === 'oeil' ? '/oeil/mes-signalements' : role === 'client' ? '/client/mes-signalements' : '/';
    default:                                   return '/';
  }
}

// ── Mesure (chantier 2 lot 1 bis, 2026-09-27) ─────────────────────────────────────────────────
// Appareil d'un abonnement : 'android' | 'ios' | 'desktop'. L'indice du navigateur (envoyé par
// le frontend à l'abonnement, détection iPadOS comprise) prime ; sinon déduit du user-agent. Un
// abonnement Web Push n'existe que sur ces 3 familles (iOS : PWA installée uniquement).
const DEVICES = new Set(['android', 'ios', 'desktop']);
function deviceFromSubscription(userAgent, hint) {
  if (DEVICES.has(hint)) return hint;
  const ua = String(userAgent || '');
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  return 'desktop';
}

// Jeton d'accusé d'un push : HMAC(notificationId.subscriptionId), clé dérivée de JWT_SECRET
// (aucune nouvelle variable d'environnement). Glissé dans le contenu CHIFFRÉ du push (seul
// l'appareil destinataire le lit) : le service worker n'a pas accès au JWT de l'app (stocké dans
// localStorage), il prouve donc avec ce jeton qu'il a bien reçu CE push sur CET abonnement.
// Aucune donnée personnelle : deux identifiants numériques + une signature.
let ackKey = null;
function getAckKey() {
  if (!ackKey && process.env.JWT_SECRET) {
    ackKey = crypto.createHmac('sha256', process.env.JWT_SECRET).update('shoofly-push-ack-v1').digest();
  }
  return ackKey;
}
function ackToken(notificationId, subscriptionId) {
  const key = getAckKey();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(`${notificationId}.${subscriptionId}`).digest('base64url');
}
function verifyAckToken(notificationId, subscriptionId, token) {
  const expected = ackToken(notificationId, subscriptionId);
  if (!expected || typeof token !== 'string' || token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

// Délai d'attente par envoi (chantier 2, 2026-09-26) : un fournisseur push qui ne répond pas ne
// doit pas garder indéfiniment une promesse (et, via le limiteur de notify(), une place de
// concurrence). Option `timeout` de web-push = délai d'inactivité du socket.
const PUSH_SEND_TIMEOUT_MS = 8000;
const DEFAULT_TTL_SECONDS = 3600;
const URGENCIES = new Set(['very-low', 'low', 'normal', 'high']);

// Un seul POST chiffré vers un endpoint. Ne lève jamais : renvoie une forme normalisée que
// sendWebPush interprète pour journaliser + neutraliser les endpoints morts.
// opts.ttl (s) / opts.urgency : transmis au service push (en-têtes TTL / Urgency). Par défaut,
// comportement d'avant : TTL 3600 s, urgence « normal » (défaut web-push).
async function sendToSubscription(sub, payloadJson, opts = {}) {
  const subscription = {
    endpoint: sub.endpoint,
    keys: sub.keys || {},
  };
  const options = { TTL: Number.isFinite(opts.ttl) && opts.ttl >= 0 ? Math.round(opts.ttl) : DEFAULT_TTL_SECONDS, timeout: PUSH_SEND_TIMEOUT_MS };
  if (URGENCIES.has(opts.urgency)) options.urgency = opts.urgency;
  try {
    await webpush.sendNotification(subscription, payloadJson, options);
    return { ok: true };
  } catch (err) {
    const statusCode = err && typeof err.statusCode === 'number' ? err.statusCode : null;
    // 404 / 410 = endpoint révoqué par le navigateur (désinstallation PWA, permission retirée,
    // profil supprimé). Standard Web Push : on ne réessaie pas, on neutralise la ligne.
    const gone = statusCode === 404 || statusCode === 410;
    return { ok: false, gone, statusCode, errorMessage: err ? err.message : 'Erreur inconnue' };
  }
}

// Journalise un envoi (succès OU échec) — c'est ici que naît le seul « délivré » réaliste
// (status='sent' = « le provider a accepté le POST chiffré », exactement comme response.ok
// pour Wasel/Resend). Best-effort : une erreur d'écriture de log ne remonte jamais.
async function logSend(db, row) {
  try {
    await db.query(
      `INSERT INTO push_send_log
        (subscription_id, user_id, notification_id, event_key, status, provider_status, error_message, device)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.subscription_id || null, row.user_id, row.notification_id || null,
       row.event_key || null, row.status, row.provider_status || null, row.error_message || null,
       row.device || null]
    );
  } catch (err) {
    console.error('[push] Échec écriture push_send_log :', err.message);
  }
}

// Envoie une notification push à TOUS les abonnements actifs d'un utilisateur. Ne lève jamais.
// Renvoie true si au moins un envoi a été accepté par le provider, false sinon (utile pour une
// future escalade : « aucun push livré » → repli email/WhatsApp).
//   payload : { title, body, url?, tag?, urgent?, notificationId?, eventKey?, urgency?, ttl? }
//             urgency/ttl : options de livraison (non incluses dans le contenu chiffré).
//   db      : pool partagé par défaut (même pattern que sendWhatsAppTemplate).
async function sendWebPush(userId, payload, db = getDb()) {
  if (!vapidConfigured) return false;
  if (!userId || !payload || !payload.title) return false;

  let subs;
  try {
    const { rows } = await db.query(
      `SELECT id, endpoint, keys, device FROM push_subscriptions WHERE user_id=$1 AND disabled_at IS NULL`,
      [userId]
    );
    subs = rows;
  } catch (err) {
    console.error('[push] Lecture push_subscriptions échouée :', err.message);
    return false;
  }

  if (!subs.length) {
    await logSend(db, {
      user_id: userId, notification_id: payload.notificationId, event_key: payload.eventKey,
      status: 'skipped_no_sub',
    });
    return false;
  }

  const baseContent = {
    title: payload.title,
    body: payload.body || '',
    url: payload.url || '/',
    tag: payload.tag || 'shoofly',
    urgent: !!payload.urgent,
  };

  let anySent = false;
  for (const sub of subs) {
    // Contenu PAR abonnement (lot 1 bis) : nid/sid/ack permettent au service worker d'accuser
    // réception puis clic (POST /api/push/ack). Sans notification source (ou sans clé) : contenu
    // d'avant, aucun accusé.
    const content = { ...baseContent };
    const token = payload.notificationId ? ackToken(payload.notificationId, sub.id) : null;
    if (token) { content.nid = payload.notificationId; content.sid = sub.id; content.ack = token; }
    const payloadJson = JSON.stringify(content);
    const result = await sendToSubscription(sub, payloadJson, { urgency: payload.urgency, ttl: payload.ttl });
    if (result.ok) {
      anySent = true;
      // Ligne 'sent' écrite AVANT la mise à jour de l'abonnement (lot 1 bis) : l'accusé
      // « delivered » du service worker vient la compléter et peut arriver très vite.
      await logSend(db, {
        subscription_id: sub.id, user_id: userId, notification_id: payload.notificationId,
        event_key: payload.eventKey, status: 'sent', provider_status: 200, device: sub.device,
      });
      await db.query(
        `UPDATE push_subscriptions SET last_push_at=NOW(), last_success_at=NOW(), failure_count=0 WHERE id=$1`,
        [sub.id]
      ).catch((e) => console.error('[push] MAJ succès abonnement échouée :', e.message));
    } else if (result.gone) {
      await db.query(
        `UPDATE push_subscriptions SET last_push_at=NOW(), last_failure_at=NOW(), disabled_at=NOW() WHERE id=$1`,
        [sub.id]
      ).catch((e) => console.error('[push] Neutralisation abonnement échouée :', e.message));
      await logSend(db, {
        subscription_id: sub.id, user_id: userId, notification_id: payload.notificationId,
        event_key: payload.eventKey, status: 'expired_endpoint', provider_status: result.statusCode, device: sub.device,
        error_message: result.errorMessage,
      });
    } else {
      await db.query(
        `UPDATE push_subscriptions SET last_push_at=NOW(), last_failure_at=NOW(), failure_count=failure_count+1 WHERE id=$1`,
        [sub.id]
      ).catch((e) => console.error('[push] Incrément échec abonnement échoué :', e.message));
      await logSend(db, {
        subscription_id: sub.id, user_id: userId, notification_id: payload.notificationId,
        event_key: payload.eventKey, status: 'provider_error', provider_status: result.statusCode, device: sub.device,
        error_message: result.errorMessage,
      });
    }
  }
  return anySent;
}

// Vérification de santé du canal push — miroir de checkWhatsAppHealth (jobs/whatsappRetry.js).
// L'alerte part par Sentry → email (jamais par push : une panne push empêcherait sa propre
// alerte). Fingerprint fixe → un seul issue Sentry tant qu'il reste ouvert. Ne compte que les
// échecs provider (pas les endpoints périmés, qui sont un événement de cycle de vie normal).
async function checkPushHealth(db = getDb()) {
  try {
    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM push_send_log
       WHERE status='provider_error' AND created_at > NOW() - INTERVAL '1 hour'`
    );
    if (count >= HEALTH_ALERT_THRESHOLD) {
      console.error(`🚨 Alerte santé push : ${count} échecs provider sur la dernière heure (seuil=${HEALTH_ALERT_THRESHOLD})`);
      Sentry.captureMessage(
        `Push — ${count} échecs d'envoi provider sur la dernière heure (seuil ${HEALTH_ALERT_THRESHOLD})`,
        { level: 'error', fingerprint: ['push-health-alert'], tags: { alert: 'push_health' } }
      );
    }
  } catch (e) {
    console.error('❌ Vérification santé push error:', e.message);
  }
}

module.exports = { sendWebPush, checkPushHealth, deepLinkFor, isPushConfigured, deviceFromSubscription, ackToken, verifyAckToken };
