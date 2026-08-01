// Paiement client réel via PayZone (sandbox — voir .env). La mission n'est créée qu'à la
// confirmation du paiement (callback webhook PayZone), jamais au moment du formulaire —
// voir mission_payment_attempts (db/schema.js) et le rapport de session pour le détail.
const crypto = require('crypto');
const router = require('express').Router();
const { validationResult } = require('express-validator');
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const walletService = require('../services/walletService');
const { getSetting } = require('../utils/settings');
const { buildPaywallPayload, verifyCallbackSignature } = require('../services/payzone');
const cashplusService = require('../services/cashplus');

// Réutilise les validateurs, la tarification (pricing()) et la logique de création de
// mission déjà écrites pour POST /missions (routes/missions.js) — jamais dupliquées ici.
const missionRoutesModule = require('./missions');
const {
  missionCreateValidators,
  missionCreateLimiter,
  prepareMissionInsert,
  insertMissionRecord,
  notifyNewMission,
  notify,
} = missionRoutesModule;

// ── POST /payments/payzone/init ── Client démarre un paiement pour une nouvelle mission ──
// Mêmes validations et même tarification que POST /missions (réutilisées, pas dupliquées) —
// mais AUCUNE mission n'est créée ici : seule une tentative de paiement (mission_payment_attempts,
// status='created') est enregistrée, avec la version déjà validée/tarifée du formulaire
// (mission_payload). La mission réelle n'existe qu'après confirmation du paiement par
// POST /payments/payzone/callback, avec exactement ces données — jamais re-validées ni
// re-tarifées à ce moment-là (garantit que le montant facturé via PayZone correspond
// exactement à la mission créée, même si le taux de commission change entre-temps).
router.post('/payzone/init', missionCreateLimiter, authenticate, requireRole('client'), missionCreateValidators, asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const { error, insert } = await prepareMissionInsert(db, req.user.id, req.body);
  if (error) return res.status(400).json({ error });

  // Le montant réellement facturé au client est insert.price (celui après réduction promo
  // éventuelle) — jamais original_price, qui ne sert qu'au calcul de la commission dans
  // prepareMissionInsert. Un prix nul (mission offerte via code promo 'free') n'a rien à
  // facturer : ce cas doit passer par POST /missions directement, pas par PayZone.
  const chargeAmount = parseFloat(insert.price);
  if (!(chargeAmount > 0)) {
    return res.status(400).json({ error: 'Montant nul — aucun paiement requis, utilisez la création de mission directe (POST /missions).' });
  }

  const chargeId = crypto.randomUUID();
  await db.query(
    `INSERT INTO mission_payment_attempts (client_id, mission_payload, price, charge_id, status)
     VALUES ($1,$2,$3,$4,'created')`,
    [req.user.id, JSON.stringify(insert), chargeAmount, chargeId]
  );

  const { payloadString, signature } = buildPaywallPayload({
    customerId: req.user.id,
    chargeId,
    price: chargeAmount,
    description: insert.title,
  });

  res.status(201).json({
    attemptId: chargeId,
    paywallUrl: process.env.PAYZONE_PAYWALL_URL,
    payload: payloadString,
    signature,
  });
}));

// ── POST /payments/payzone/callback ── Webhook serveur-à-serveur PayZone (PUBLIC) ──
// AUCUNE authentification JWT possible ici (PayZone ne connaît pas notre système d'auth) —
// la SEULE protection est la vérification de signature ci-dessous, stricte et bloquante.
// req.body est un Buffer BRUT (voir express.raw() scopé à cette route précise dans
// index.js, monté AVANT express.json/xss/hpp/mongoSanitize globaux) : la signature HMAC
// doit porter sur ces octets exacts, jamais sur une version re-sérialisée après parsing.
router.post('/payzone/callback', asyncHandler(async (req, res) => {
  const rawBody = req.body;
  const signatureHeader = req.headers['x-callback-signature'];

  if (!Buffer.isBuffer(rawBody) || !verifyCallbackSignature(rawBody, signatureHeader)) {
    return res.status(403).json({ status: 'KO', message: 'Signature invalide' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ status: 'KO', message: 'Corps JSON invalide' });
  }

  const chargeId = payload.chargeId || payload.orderId;
  if (!chargeId) return res.status(200).json({ status: 'KO', message: 'chargeId manquant' });

  const db = getDb();
  const { rows: [attempt] } = await db.query(
    `SELECT * FROM mission_payment_attempts WHERE charge_id=$1`, [chargeId]
  );
  if (!attempt) return res.status(200).json({ status: 'KO', message: 'Tentative de paiement introuvable' });

  const isApproved = payload.status === 'CHARGED'
    && Array.isArray(payload.transactions)
    && payload.transactions.some(t => t.state === 'APPROVED' && t.resultCode === 0);

  if (isApproved) {
    if (attempt.status === 'charged') {
      // Rejeu du webhook (PayZone peut renvoyer plusieurs fois) — idempotence stricte,
      // aucune deuxième mission créée.
      return res.status(200).json({ status: 'OK', message: 'Paiement déjà traité' });
    }

    let mission;
    try {
      mission = await walletService.withTransaction(db, async (client) => {
        // Garde d'idempotence sur l'UPDATE lui-même (WHERE status='created') : si deux
        // callbacks arrivent en concurrence, un seul gagne la course et crée la mission.
        const { rows: [locked] } = await client.query(
          `UPDATE mission_payment_attempts SET status='charged', confirmed_at=NOW()
           WHERE charge_id=$1 AND status='created' RETURNING *`,
          [chargeId]
        );
        if (!locked) {
          const err = new Error('ALREADY_PROCESSED');
          err.code = 'ALREADY_PROCESSED';
          throw err;
        }

        // freePromo=null : une tentative de paiement PayZone n'existe que pour un montant
        // > 0 (voir garde dans POST /payzone/init) — le cas "mission offerte, prix nul" ne
        // passe jamais par ce flux, donc freePromo (qui ne s'applique qu'à price=0) est
        // toujours sans objet ici.
        const insertedMission = await insertMissionRecord(client, locked.client_id, locked.mission_payload, null);
        await client.query(`UPDATE mission_payment_attempts SET mission_id=$1 WHERE charge_id=$2`, [insertedMission.id, chargeId]);
        return insertedMission;
      });
    } catch (e) {
      if (e.code === 'ALREADY_PROCESSED') {
        return res.status(200).json({ status: 'OK', message: 'Paiement déjà traité' });
      }
      throw e;
    }

    // Notifications APRÈS le commit (règle du projet : jamais de notify() dans une transaction).
    const emitToUser = req.app.get('emitToUser');
    const io = req.app.get('io');
    await notifyNewMission(db, mission, emitToUser, io);

    return res.status(200).json({ status: 'OK', message: 'Mission créée' });
  }

  if (payload.status === 'DECLINED') {
    await db.query(`UPDATE mission_payment_attempts SET status='declined' WHERE charge_id=$1 AND status='created'`, [chargeId]);
    return res.status(200).json({ status: 'OK', message: 'Paiement décliné, enregistré' });
  }

  // Statut ni CHARGED/APPROVED ni DECLINED (ex: PENDING intermédiaire) — accusé de
  // réception sans action, pour ne pas faire réessayer PayZone indéfiniment.
  console.warn(`[payzone] callback statut inattendu pour charge_id=${chargeId}: ${payload.status}`);
  return res.status(200).json({ status: 'OK', message: 'Notification reçue' });
}));

// ── GET /payments/payzone/status/:attemptId ── Page de retour client : le callback a-t-il
// déjà été traité ? Ne jamais faire confiance à ce que l'URL de retour PayZone affiche. ──
router.get('/payzone/status/:attemptId', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: [attempt] } = await db.query(
    `SELECT charge_id, client_id, status, mission_id, price, created_at, confirmed_at
     FROM mission_payment_attempts WHERE charge_id=$1`,
    [req.params.attemptId]
  );
  if (!attempt) return res.status(404).json({ error: 'Tentative introuvable' });
  if (attempt.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });

  res.json({
    attemptId: attempt.charge_id,
    status: attempt.status,
    missionId: attempt.mission_id,
    price: attempt.price,
    createdAt: attempt.created_at,
    confirmedAt: attempt.confirmed_at,
  });
}));

// ── GET /payments/payzone/failed-attempts ── Tentatives à proposer en nouvel essai ──
router.get('/payzone/failed-attempts', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  const abandonedMinutes = await getSetting(db, 'payment_attempt_abandoned_minutes', 30);

  const { rows } = await db.query(`
    SELECT charge_id AS attempt_id, price, status, mission_payload->>'title' AS title, created_at
    FROM mission_payment_attempts
    WHERE client_id=$1
      AND (
        status IN ('declined','error')
        OR (status='created' AND created_at <= NOW() - INTERVAL '1 minute' * $2::numeric)
      )
    ORDER BY created_at DESC
  `, [req.user.id, abandonedMinutes]);

  res.json({ attempts: rows });
}));

// ── POST /payments/payzone/retry/:attemptId ── Relance une tentative déclinée/abandonnée ──
router.post('/payzone/retry/:attemptId', missionCreateLimiter, authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: [attempt] } = await db.query(
    `SELECT * FROM mission_payment_attempts WHERE charge_id=$1`, [req.params.attemptId]
  );
  if (!attempt) return res.status(404).json({ error: 'Tentative introuvable' });
  if (attempt.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });

  const abandonedMinutes = await getSetting(db, 'payment_attempt_abandoned_minutes', 30);
  const isAbandonedCreated = attempt.status === 'created'
    && (Date.now() - new Date(attempt.created_at).getTime()) > abandonedMinutes * 60000;
  if (!['declined', 'error'].includes(attempt.status) && !isAbandonedCreated) {
    return res.status(400).json({ error: `Cette tentative ne peut pas être relancée (statut actuel : ${attempt.status})` });
  }

  const chargeId = crypto.randomUUID();
  await db.query(
    `INSERT INTO mission_payment_attempts (client_id, mission_payload, price, charge_id, status)
     VALUES ($1,$2,$3,$4,'created')`,
    [attempt.client_id, JSON.stringify(attempt.mission_payload), attempt.price, chargeId]
  );

  const { payloadString, signature } = buildPaywallPayload({
    customerId: attempt.client_id,
    chargeId,
    price: attempt.price,
    description: attempt.mission_payload.title,
  });

  res.status(201).json({
    attemptId: chargeId,
    paywallUrl: process.env.PAYZONE_PAYWALL_URL,
    payload: payloadString,
    signature,
  });
}));

// ── POST /payments/cashplus/callback ── Webhook CashPlus (PUBLIC) ──────────
// Voir RECAP_INTEGRATION_CASHPLUS.md. Contrairement à PayZone (signature sur le corps brut
// entier, ci-dessus), le HMAC CashPlus ne porte que sur request_id+secret_key (voir services/
// cashplus.js) — req.body parsé normalement (json ou urlencoded, voir index.js) suffit, pas
// besoin d'express.raw() ici. Réponse TOUJOURS en texte brut "OK"/"NOK" (jamais JSON, exigé par
// CashPlus) — la doc résumée fournie ne précise aucune sémantique de statut HTTP par cas
// (contrairement à PayZone, dont la doc distinguait explicitement 403 signature invalide / 200
// KO métier) : HTTP 200 est donc utilisé pour tout rejet "métier" (request_id inconnu), seul un
// HMAC invalide renvoie 403 — par analogie directe avec verifyCallbackSignature ci-dessus,
// signalé comme hypothèse dans le rapport de session faute de précision équivalente pour CashPlus.
router.post('/cashplus/callback', asyncHandler(async (req, res) => {
  const sendPlain = (status, text) => res.status(status).type('text/plain').send(text);
  const { request_id: requestId, hmac, amount: payloadAmount } = req.body || {};

  if (!cashplusService.verifyCallbackHmac(requestId, hmac)) {
    console.error(`[cashplus] Callback rejeté — HMAC invalide ou champs manquants (request_id=${requestId || '(absent)'})`);
    return sendPlain(403, 'NOK');
  }

  const db = getDb();
  const { rows: [request] } = await db.query(`SELECT * FROM cashplus_recharge_requests WHERE request_id=$1`, [requestId]);
  if (!request) {
    console.error(`[cashplus] Callback pour request_id inconnu: ${requestId}`);
    return sendPlain(200, 'NOK');
  }

  // L'amount du payload callback n'est PAS authentifié par le HMAC (voir services/cashplus.js)
  // — jamais utilisé pour le crédit, uniquement comparé pour signaler toute divergence. Le
  // crédit ci-dessous se base systématiquement sur `locked.amount` (valeur stockée à la
  // génération, verrouillée par la transaction), jamais sur payloadAmount.
  if (payloadAmount !== undefined && payloadAmount !== null && Number(payloadAmount) !== Number(request.amount)) {
    console.error(`[cashplus] Divergence de montant — request_id=${requestId} stocké=${request.amount} payload=${payloadAmount}. Crédit basé sur le montant stocké (source de vérité, jamais le payload).`);
  }

  try {
    await walletService.withTransaction(db, async (client) => {
      // Idempotence + auto-guérison d'une expiration prématurée du cron (jobs/cashplusExpiry.js) :
      // un callback HMAC-valide fait toujours foi sur un statut local 'expired' (le paiement a
      // réellement eu lieu selon CashPlus, l'estimation optimiste du cron doit céder) — seul
      // 'completed' bloque un second crédit. Garde d'idempotence posée sur l'UPDATE lui-même
      // (WHERE status IN (...)), pas une SELECT préalable — même pattern que le callback PayZone
      // ci-dessus, pour éviter toute course entre deux callbacks concurrents.
      const { rows: [locked] } = await client.query(
        `UPDATE cashplus_recharge_requests SET status='completed', completed_at=NOW()
         WHERE request_id=$1 AND status IN ('pending','expired') RETURNING *`,
        [requestId]
      );
      if (!locked) {
        const err = new Error('ALREADY_PROCESSED');
        err.code = 'ALREADY_PROCESSED';
        throw err;
      }
      await walletService.credit(client, locked.oeil_id, 'oeil', Number(locked.amount), 'Recharge wallet CashPlus', null);
    });
  } catch (e) {
    if (e.code === 'ALREADY_PROCESSED') return sendPlain(200, 'OK'); // rejeu — idempotent, aucun second crédit
    throw e;
  }

  // Notification APRÈS le commit (règle du projet : jamais de notify() dans une transaction) —
  // même contrat que notifyNewMission ci-dessus. action_type 'gains_page' réutilisé tel quel
  // (même destination Œil que les notifications de virement, routes/users.js PUT /admin/
  // withdrawals/:id) plutôt qu'une nouvelle valeur non câblée côté frontend.
  const emitToUser = req.app.get('emitToUser');
  await notify(
    db, request.oeil_id,
    '💰 Recharge effectuée',
    `Votre wallet a été crédité de ${Number(request.amount).toFixed(2)} MAD suite à votre recharge CashPlus.`,
    'info', null, emitToUser, 'gains_page',
    'cashplusRechargeCompletedTitle', 'cashplusRechargeCompletedBody',
    { amount: Number(request.amount) }
  );

  return sendPlain(200, 'OK');
}));

module.exports = router;
