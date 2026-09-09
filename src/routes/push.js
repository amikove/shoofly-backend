const router = require('express').Router();
const { getDb } = require('../db/schema');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { isPushConfigured } = require('../services/push');

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
    `INSERT INTO push_subscriptions (user_id, platform, provider, endpoint, keys, user_agent, last_seen_at)
     VALUES ($1, $2, 'webpush', $3, $4, $5, NOW())
     ON CONFLICT (user_id, endpoint) DO UPDATE
       SET keys = EXCLUDED.keys,
           user_agent = EXCLUDED.user_agent,
           platform = EXCLUDED.platform,
           last_seen_at = NOW(),
           disabled_at = NULL,
           failure_count = 0
     RETURNING id`,
    [req.user.id, platform, endpoint, JSON.stringify(keys), (req.headers['user-agent'] || '').slice(0, 500)]
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

module.exports = router;
