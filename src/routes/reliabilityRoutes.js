const router = require('express').Router();
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');
const { getReliabilityLevel, reactivateWithCorrectiveEvent } = require('../utils/reliabilityScore');
const asyncHandler = require('../middleware/asyncHandler');

const DEFAULT_REACTIVATION_SCORE = 70; // score appliqué à une réintégration si l'admin n'en précise pas un autre

// ── GET /reliability/me — Œil consulte son propre score ───
router.get('/me', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: [user] } = await db.query(
    `SELECT reliability_score, is_suspended, suspended_at, suspended_reason FROM users WHERE id=$1`,
    [req.user.id]
  );

  const { rows: events } = await db.query(
    `SELECT points, reason, is_grave, created_at FROM reliability_events
     WHERE oeil_id=$1 ORDER BY created_at DESC LIMIT 30`,
    [req.user.id]
  );

  const { rows: reviewRequests } = await db.query(
    `SELECT * FROM reliability_review_requests
     WHERE oeil_id=$1 ORDER BY created_at DESC LIMIT 5`,
    [req.user.id]
  );

  const level = getReliabilityLevel(user.reliability_score);

  res.json({
    score: user.reliability_score,
    level,
    is_suspended: user.is_suspended,
    suspended_at: user.suspended_at,
    suspended_reason: user.suspended_reason,
    events,
    review_requests: reviewRequests,
  });
}));

// ── POST /reliability/review-request — demander un examen ─
router.post('/review-request', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { message } = req.body;

  if (!message || message.trim().length < 10) {
    return res.status(400).json({ error: 'Veuillez détailler votre situation (minimum 10 caractères)' });
  }

  const { rows: [existing] } = await db.query(
    `SELECT id FROM reliability_review_requests WHERE oeil_id=$1 AND status='pending'`,
    [req.user.id]
  );
  if (existing) return res.status(400).json({ error: 'Une demande est déjà en cours d\'examen' });

  const { rows: [request] } = await db.query(
    `INSERT INTO reliability_review_requests (oeil_id, message) VALUES ($1, $2) RETURNING *`,
    [req.user.id, message]
  );

  const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
  for (const admin of admins) {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
       VALUES ($1, $2, $3, 'warning', 'admin_fiabilite', $4, $5, $6)`,
      [admin.id, '📨 Demande d\'examen reçue', `Un Œil a demandé un examen de son dossier suite à suspension.`, 'reviewRequestReceivedAdminTitle', 'reviewRequestReceivedAdminBody', null]
    );
  }

  res.status(201).json({ request });
}));

// ── GET /reliability/admin/requests — liste admin ─────────
router.get('/admin/requests', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { status = 'pending' } = req.query;

  const { rows } = await db.query(`
    SELECT r.*, u.first_name, u.last_name, u.email, u.reliability_score
    FROM reliability_review_requests r
    JOIN users u ON u.id = r.oeil_id
    WHERE r.status=$1
    ORDER BY r.created_at ASC
  `, [status]);

  res.json({ requests: rows });
}));

// ── GET /reliability/admin/:oeilId/history — historique complet ──
router.get('/admin/:oeilId/history', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: events } = await db.query(
    `SELECT e.*,
      m.title AS mission_title,
      m.status AS mission_status,
      m.scheduled_at AS mission_scheduled_at,
      m.city AS mission_city,
      m.quartier AS mission_quartier,
      c.first_name AS client_first_name,
      c.last_name AS client_last_name,
      (SELECT COUNT(*)::int FROM mission_media WHERE mission_id=m.id) AS media_count
     FROM reliability_events e
     LEFT JOIN missions m ON m.id = e.mission_id
     LEFT JOIN users c ON c.id = m.client_id
     WHERE e.oeil_id=$1 ORDER BY e.created_at DESC`,
    [req.params.oeilId]
  );
  res.json({ events });
}));

// ── POST /reliability/admin/requests/:id/decide ───────────
router.post('/admin/requests/:id/decide', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { decision, response, reset_score } = req.body; // decision: 'approved' | 'rejected'

  const { rows: [request] } = await db.query(
    `UPDATE reliability_review_requests SET status=$1, admin_response=$2, reviewed_by=$3, reviewed_at=NOW()
     WHERE id=$4 RETURNING *`,
    [decision, response || null, req.user.id, req.params.id]
  );
  if (!request) return res.status(404).json({ error: 'Demande introuvable' });

  if (decision === 'approved') {
      const newScore = reset_score || DEFAULT_REACTIVATION_SCORE;
      await reactivateWithCorrectiveEvent(db, request.oeil_id, newScore, req.user.id);
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
       VALUES ($1, '✅ Compte réactivé', $2, 'success', 'none', $3, $4, $5)`,
      [request.oeil_id, `Votre dossier a été examiné et votre compte est réactivé. ${response || ''}`, 'accountReactivatedTitle', 'accountReactivatedBody', JSON.stringify({ response: response || '' })]
    );
  } else {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
       VALUES ($1, '❌ Demande refusée', $2, 'error', 'none', $3, $4, $5)`,
      [request.oeil_id, `Votre demande d'examen a été refusée. ${response || ''}`, 'reviewRequestRejectedTitle', 'reviewRequestRejectedBody', JSON.stringify({ response: response || '' })]
    );
  }

  res.json({ request });
}));

// ── GET /reliability/admin/suspended — Œils actuellement suspendus ──
router.get('/admin/suspended', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`
    SELECT id, first_name, last_name, email, city, quartier,
           reliability_score, suspended_at, suspended_reason
    FROM users
    WHERE role='oeil' AND is_suspended=true
    ORDER BY suspended_at DESC
  `);
  res.json({ oeils: rows });
}));

// ── GET /reliability/admin/all-scores — tous les Œils avec leur score, triable + paginé ──
router.get('/admin/all-scores', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { city, quartier, page = 1, limit = 20, sort = 'score_asc' } = req.query;
  const offset = (page - 1) * limit;

  const SORT_MAP = {
    score_asc:  'reliability_score ASC',
    score_desc: 'reliability_score DESC',
    city_asc:   'city ASC, quartier ASC',
    quartier_asc: 'quartier ASC, city ASC',
  };
  const orderBy = SORT_MAP[sort] || 'reliability_score ASC';

  let where = [`role='oeil'`], params = [];
  let p = 1;
  if (city)     { where.push(`city=$${p++}`);     params.push(city); }
  if (quartier) { where.push(`quartier=$${p++}`); params.push(quartier); }
  const wc = 'WHERE ' + where.join(' AND ');

  const { rows: oeils } = await db.query(`
    SELECT id, first_name, last_name, email, city, quartier,
           reliability_score, is_suspended
    FROM users
    ${wc}
    ORDER BY ${orderBy}
    LIMIT $${p++} OFFSET $${p++}
  `, [...params, limit, offset]);

  const { rows: [{ n: total }] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM users ${wc}`, params
  );

  res.json({ oeils, total, page: +page, pages: Math.ceil(total / limit) });
}));

// ── POST /reliability/admin/:oeilId/reactivate — réactivation directe (sans demande d'examen) ──
router.post('/admin/:oeilId/reactivate', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
    const db = getDb();
    const { reset_score } = req.body;
    const newScore = reset_score || DEFAULT_REACTIVATION_SCORE;
    const { rows: [oeilCheck] } = await db.query(`SELECT id, first_name, last_name FROM users WHERE id=$1 AND role='oeil'`, [req.params.oeilId]);
    if (!oeilCheck) return res.status(404).json({ error: 'Œil introuvable' });
    await reactivateWithCorrectiveEvent(db, req.params.oeilId, newScore, req.user.id);
    const oeil = oeilCheck;

  await db.query(
    `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
     VALUES ($1, '✅ Compte réactivé', $2, 'success', 'none', $3, $4, $5)`,
    [oeil.id, `Votre compte a été réactivé par un administrateur. Score de réintégration : ${newScore}%.`, 'accountReactivatedTitle', 'accountReactivatedAdminBody', JSON.stringify({ score: newScore })]
  );

  res.json({ ok: true, oeil });
}));

module.exports = router;