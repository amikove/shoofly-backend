const router = require('express').Router();
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const asyncHandler = require('../middleware/asyncHandler');

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Contestation d'un compte bloqué (is_active=false) — chantier L4 (2026-09-09).
//
// Structure calquée à l'identique sur la demande d'examen d'un Œil suspendu
// (reliabilityRoutes.js : POST /review-request + POST /admin/requests/:id/decide) — même cycle
// pending → approved|rejected, même admin_response, même re-soumission après décision. Table
// account_block_appeals (schema.js). Différence : porte sur user_id (tout rôle), car un blocage
// anti-fraude peut viser un client comme un Œil.
//
// Deux niveaux de recours selon users.deactivation_context (posé par les 3 sites d'écriture de
// is_active=false) :
//   - 'fraud_block' (ou NULL = blocage antérieur au chantier) → canal MINIMAL : UNE seule
//     contestation, jamais rouvrable (409 si une ligne existe déjà, quel que soit son statut).
//   - 'admin_toggle' / 'noshow_strikes' → canal COMPLET : re-soumissible après décision (400
//     seulement si une 'pending' existe), + fil de tickets (whitelisté dans middleware/auth.js).
//
// Les routes /  et  /mine sont whitelistées pour un compte bloqué (isDeactivatedAccountAllowed,
// middleware/auth.js) ; les routes /admin/* passent par les gardes admin habituelles.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const MIN_MESSAGE_LEN = 10;

// ── POST /api/block-appeals — le compte bloqué dépose une contestation ──────────────────────
router.post('/', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');

  // Défensif : la route est whitelistée pour is_active=false, mais un compte actif ne doit pas
  // pouvoir créer de contestation (aucun sens, et polluerait l'écran admin).
  if (req.user.is_active !== false) {
    return res.status(400).json({ error: "Votre compte n'est pas bloqué." });
  }

  const { message } = req.body;
  if (!message || message.trim().length < MIN_MESSAGE_LEN) {
    return res.status(400).json({ error: 'Veuillez détailler votre situation (minimum 10 caractères)' });
  }

  const ctx = req.user.deactivation_context;
  const fullChannel = ctx === 'admin_toggle' || ctx === 'noshow_strikes';

  if (fullChannel) {
    const { rows: [pending] } = await db.query(
      `SELECT id FROM account_block_appeals WHERE user_id=$1 AND status='pending'`, [req.user.id]
    );
    if (pending) return res.status(400).json({ error: "Une contestation est déjà en cours d'examen." });
  } else {
    // Canal minimal (blocage anti-fraude) : une seule contestation, définitivement — pas de
    // relance possible même après un refus.
    const { rows: [any] } = await db.query(
      `SELECT id FROM account_block_appeals WHERE user_id=$1 LIMIT 1`, [req.user.id]
    );
    if (any) {
      return res.status(409).json({ error: 'Une contestation a déjà été déposée pour ce compte. Notre équipe la traitera.' });
    }
  }

  const { rows: [appeal] } = await db.query(
    `INSERT INTO account_block_appeals (user_id, message) VALUES ($1, $2) RETURNING *`,
    [req.user.id, message.trim()]
  );

  // Notif admins — même forme que A49 (reliabilityRoutes.js:83) : IA sans socket live (un admin
  // hors-ligne la verra au prochain chargement ; l'écran /admin/block-appeals liste les 'pending').
  const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
  for (const admin of admins) {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
       VALUES ($1, $2, $3, 'warning', 'admin_block_appeals', $4, $5, $6)`,
      [
        admin.id,
        '📨 Contestation de blocage reçue',
        `Un compte bloqué (${ctx === 'fraud_block' ? 'anti-fraude' : ctx === 'noshow_strikes' ? 'strikes no-show' : 'désactivation admin'}) a déposé une contestation.`,
        'blockAppealReceivedAdminTitle',
        'blockAppealReceivedAdminBody',
        JSON.stringify({ context: ctx || 'unknown' }),
      ]
    );
  }

  res.status(201).json({ appeal });
}));

// ── GET /api/block-appeals/mine — le compte bloqué consulte ses contestations + réponses admin ─
router.get('/mine', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: appeals } = await db.query(
    `SELECT id, message, status, admin_response, reviewed_at, created_at
       FROM account_block_appeals WHERE user_id=$1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ appeals, deactivation_context: req.user.deactivation_context || null });
}));

// ══ ADMIN ═════════════════════════════════════════════════════════════════════════════════════
// requirePermission('moderation') : le cas le plus sensible (blocage anti-fraude) est déjà en
// 'moderation' (antiFraud.js POST /block). Écran unique /admin/block-appeals, symétrique de
// l'onglet « Demandes » de AdminFiabilite.jsx (Œil is_suspended).

// ── GET /api/block-appeals/admin — liste des contestations par statut ──────────────────────
router.get('/admin', authenticate, requireRole('admin'), requirePermission('moderation'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { status = 'pending' } = req.query;
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }
  const { rows } = await db.query(`
    SELECT a.*, u.first_name, u.last_name, u.email, u.role AS user_role, u.deactivation_context
    FROM account_block_appeals a
    JOIN users u ON u.id = a.user_id
    WHERE a.status = $1
    ORDER BY a.created_at ASC
  `, [status]);
  res.json({ appeals: rows });
}));

// ── POST /api/block-appeals/admin/:id/decide — approuver / refuser ────────────────────────
router.post('/admin/:id/decide', authenticate, requireRole('admin'), requirePermission('moderation'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const { decision, response } = req.body; // 'approved' | 'rejected'

  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision doit valoir 'approved' ou 'rejected'" });
  }

  const { rows: [appeal] } = await db.query(
    `UPDATE account_block_appeals
       SET status=$1, admin_response=$2, reviewed_by=$3, reviewed_at=NOW()
     WHERE id=$4 RETURNING *`,
    [decision, response || null, req.user.id, req.params.id]
  );
  if (!appeal) return res.status(404).json({ error: 'Contestation introuvable' });

  if (decision === 'approved') {
    // Réactivation. On lit le contexte AVANT de l'effacer pour savoir s'il faut aussi purger
    // les strikes : sinon le tout prochain strike (3e) re-bloquerait le compte immédiatement
    // (même raisonnement que POST /admin/clients/:id/unblock, users.js).
    const { rows: [target] } = await db.query(`SELECT deactivation_context FROM users WHERE id=$1`, [appeal.user_id]);
    const wasNoShow = target?.deactivation_context === 'noshow_strikes';
    await db.query(
      wasNoShow
        ? `UPDATE users SET is_active=true, deactivation_context=NULL, client_noshow_strikes=0 WHERE id=$1`
        : `UPDATE users SET is_active=true, deactivation_context=NULL WHERE id=$1`,
      [appeal.user_id]
    );
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
       VALUES ($1, '✅ Compte réactivé', $2, 'success', 'none', $3, $4, $5)`,
      [appeal.user_id, `Votre compte a été réexaminé et réactivé. ${response || ''}`.trim(),
       'accountReactivatedTitle', 'blockAppealApprovedBody', JSON.stringify({ response: response || '' })]
    );
  } else {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
       VALUES ($1, '❌ Contestation refusée', $2, 'error', 'none', $3, $4, $5)`,
      [appeal.user_id, `Votre contestation a été examinée et refusée. ${response || ''}`.trim(),
       'blockAppealRejectedTitle', 'blockAppealRejectedBody', JSON.stringify({ response: response || '' })]
    );
  }
  if (emitToUser) emitToUser(appeal.user_id, 'notification', { title: decision === 'approved' ? '✅ Compte réactivé' : '❌ Contestation refusée' });

  res.json({ appeal });
}));

module.exports = router;
