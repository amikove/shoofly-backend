const router = require('express').Router();
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');
const { getReliabilityLevel } = require('../utils/reliabilityScore');

// ── GET /reliability/me — Œil consulte son propre score ───
router.get('/me', authenticate, requireRole('oeil'), async (req, res) => {
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
});

// ── POST /reliability/review-request — demander un examen ─
router.post('/review-request', authenticate, requireRole('oeil'), async (req, res) => {
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
      `INSERT INTO notifications (user_id, title, body, type)
       VALUES ($1, $2, $3, 'warning')`,
      [admin.id, '📨 Demande d\'examen reçue', `Un Œil a demandé un examen de son dossier suite à suspension.`]
    );
  }

  res.status(201).json({ request });
});

// ── GET /reliability/admin/requests — liste admin ─────────
router.get('/admin/requests', authenticate, requireRole('admin'), async (req, res) => {
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
});

// ── GET /reliability/admin/:oeilId/history — historique complet ──
router.get('/admin/:oeilId/history', authenticate, requireRole('admin'), async (req, res) => {
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
});

// ── POST /reliability/admin/requests/:id/decide ───────────
router.post('/admin/requests/:id/decide', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const { decision, response, reset_score } = req.body; // decision: 'approved' | 'rejected'

  const { rows: [request] } = await db.query(
    `UPDATE reliability_review_requests SET status=$1, admin_response=$2, reviewed_by=$3, reviewed_at=NOW()
     WHERE id=$4 RETURNING *`,
    [decision, response || null, req.user.id, req.params.id]
  );
  if (!request) return res.status(404).json({ error: 'Demande introuvable' });

  if (decision === 'approved') {
    const newScore = reset_score || 70; // score de réintégration par défaut
    await db.query(
      `UPDATE users SET is_suspended=false, suspended_at=NULL, suspended_reason=NULL, reliability_score=$1 WHERE id=$2`,
      [newScore, request.oeil_id]
    );
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type)
       VALUES ($1, '✅ Compte réactivé', $2, 'success')`,
      [request.oeil_id, `Votre dossier a été examiné et votre compte est réactivé. ${response || ''}`]
    );
  } else {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type)
       VALUES ($1, '❌ Demande refusée', $2, 'error')`,
      [request.oeil_id, `Votre demande d'examen a été refusée. ${response || ''}`]
    );
  }

  res.json({ request });
});

module.exports = router;