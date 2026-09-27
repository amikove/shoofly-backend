const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db/schema');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { isPushConfigured, deviceFromSubscription, verifyAckToken } = require('../services/push');

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Abonnements push Web Push / VAPID — chantier push (2026-09-09).
// Le frontend (service worker + PushManager) s'abonne via POST /subscribe et se désabonne via
// DELETE /subscribe. La clé publique VAPID est servie ici pour éviter d'en faire une variable de
// build obligatoire (elle peut aussi venir de VITE_VAPID_PUBLIC_KEY — au choix côté frontend).
// Table push_subscriptions (schema.js). Envoi : services/push.js, déclenché par utils/notify.js.
// ══════════════════════════════════════════════════════════════════════════════════════════════

// ── GET /api/push/vapid-public-key ────────────────────────────────────────────────────────────
// Clé PUBLIQUE VAPID — destinée à être exposée (elle est normalement embarquée dans le bundle
// JS). Non authentifiée : le service worker peut la récupérer sans session. 503 si le canal
// n'est pas configuré côté serveur (VAPID_* absentes) → le frontend s'abstient de tenter un
// abonnement voué à l'échec.
router.get('/vapid-public-key', (req, res) => {
  if (!isPushConfigured() || !process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Canal push non configuré' });
  }
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

// ── POST /api/push/subscribe ─────────────────────────────────────────────────────────────────
// Idempotent : ré-appelé à chaque montage de l'app (rafraîchit last_seen_at, réactive un
// abonnement précédemment neutralisé si le navigateur a redonné le même endpoint).
router.post('/subscribe', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const sub = req.body && req.body.subscription ? req.body.subscription : req.body || {};
  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
  const keys = sub.keys && typeof sub.keys === 'object' ? sub.keys : null;
  const platform = typeof (req.body && req.body.platform) === 'string' ? req.body.platform : 'web';
  // Appareil (lot 1 bis, mesure) : indice du navigateur si valide, sinon déduit du user-agent.
  const userAgent = (req.headers['user-agent'] || '').slice(0, 500);
  const device = deviceFromSubscription(userAgent, req.body && req.body.device);

  // Les services push des navigateurs sont toujours en https. Exception localhost/127.0.0.1
  // pour le serveur factice de la vérification E2E (_audit/e2e/_push_mock_server.js).
  const validEndpoint = /^https:\/\/[^ ]+$/.test(endpoint)
    || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^ ]*$/.test(endpoint);
  if (!endpoint || !validEndpoint) {
    return res.status(400).json({ error: 'endpoint manquant ou invalide' });
  }
  if (!keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'keys.p256dh et keys.auth requis' });
  }

  const { rows: [row] } = await db.query(
    `INSERT INTO push_subscriptions (user_id, platform, provider, endpoint, keys, user_agent, device, last_seen_at)
     VALUES ($1, $2, 'webpush', $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id, endpoint) DO UPDATE
       SET keys = EXCLUDED.keys,
           user_agent = EXCLUDED.user_agent,
           device = EXCLUDED.device,
           platform = EXCLUDED.platform,
           last_seen_at = NOW(),
           disabled_at = NULL,
           failure_count = 0
     RETURNING id`,
    [req.user.id, platform, endpoint, JSON.stringify(keys), userAgent, device]
  );

  res.status(201).json({ ok: true, id: row.id });
}));

// ── DELETE /api/push/subscribe ───────────────────────────────────────────────────────────────
// Désabonnement explicite (l'utilisateur coupe les notifications, ou le SW détecte un endpoint
// périmé et se ré-abonne). Suppression franche de la ligne : ce n'est pas un échec à tracer,
// c'est un choix. Renvoie 200 même si rien n'a été supprimé (idempotent).
router.delete('/subscribe', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const endpoint = req.body && typeof req.body.endpoint === 'string' ? req.body.endpoint.trim() : '';
  if (!endpoint) return res.status(400).json({ error: 'endpoint requis' });

  await db.query(`DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2`, [req.user.id, endpoint]);
  res.json({ ok: true });
}));

// ── POST /api/push/ack ───────────────────────────────────────────────────────────────────────
// Accusés du service worker (chantier 2 lot 1 bis, mesure) : event 'delivered' à la réception du
// push, 'clicked' au clic (avant l'ouverture de la page). NON authentifiée par JWT — le service
// worker n'a pas accès au jeton de l'app (localStorage) — mais exige le jeton signé glissé dans le
// contenu chiffré du push (services/push.js ackToken) : il lie CETTE notification à CET abonnement,
// donc un utilisateur ne peut accuser que ses propres push (un id de notification d'autrui → 403).
// Idempotente : seule la PREMIÈRE réception / le PREMIER clic est horodaté (COALESCE), un clic
// ne réécrit pas une lecture déjà faite dans l'app. Aucune donnée personnelle en entrée ni en
// sortie. Limiteur dédié (exemptée du plafond global, index.js).
const ackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Trop de requêtes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const ACK_EVENTS = new Set(['delivered', 'clicked']);
const ACK_RETRY_MS = 1500;

router.post('/ack', ackLimiter, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const notificationId = Number(body.notificationId);
  const subscriptionId = Number(body.subscriptionId);
  const event = body.event;
  if (!Number.isSafeInteger(notificationId) || notificationId <= 0 || !Number.isSafeInteger(subscriptionId) || subscriptionId <= 0 || !ACK_EVENTS.has(event)) {
    return res.status(400).json({ error: 'notificationId, subscriptionId et event requis' });
  }
  if (!verifyAckToken(notificationId, subscriptionId, body.token)) {
    return res.status(403).json({ error: 'Jeton invalide' });
  }
  const db = getDb();
  const markLog = () => db.query(
    event === 'clicked'
      ? `UPDATE push_send_log SET delivered_at = COALESCE(delivered_at, NOW()), clicked_at = COALESCE(clicked_at, NOW())
         WHERE notification_id=$1 AND subscription_id=$2 AND status='sent'`
      : `UPDATE push_send_log SET delivered_at = COALESCE(delivered_at, NOW())
         WHERE notification_id=$1 AND subscription_id=$2 AND status='sent'`,
    [notificationId, subscriptionId]
  );
  let { rowCount } = await markLog();
  // La ligne 'sent' est écrite juste après l'acceptation par le fournisseur ; un accusé très
  // rapide peut la précéder de quelques millisecondes → un seul nouvel essai.
  if (rowCount === 0) {
    await new Promise((r) => setTimeout(r, ACK_RETRY_MS));
    ({ rowCount } = await markLog());
  }
  if (event === 'clicked') {
    // Lecture via le push — uniquement si l'abonnement appartient bien au destinataire de la
    // notification (défense en profondeur : le jeton l'impose déjà) et si elle n'était pas lue.
    await db.query(
      `UPDATE notifications n SET is_read = true, read_at = NOW(), read_via = 'push_click'
       FROM push_subscriptions s
       WHERE n.id = $1 AND s.id = $2 AND s.user_id = n.user_id AND n.is_read = false`,
      [notificationId, subscriptionId]
    );
  }
  res.json({ ok: true, recorded: rowCount > 0 });
}));

module.exports = router;
