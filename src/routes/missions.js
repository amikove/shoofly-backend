const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');

const COMMISSION = 0.20;
function pricing(price) {
  const commission = Math.round(price * COMMISSION * 100) / 100;
  return { commission, oeil_earning: price - commission };
}

async function notify(db, userId, title, body, type = 'info', missionId = null, emitToUser = null) {
  const r = await db.query(
    `INSERT INTO notifications (user_id,title,body,type,mission_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, title, body, type, missionId]
  );
  if (emitToUser) emitToUser(userId, 'notification', r.rows[0]);
}

// ── GET /missions ──────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const db = getDb();
  const { status, type, mode, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let where = [], params = [];
  let p = 1;

  if (req.user.role === 'client') {
    where.push(`m.client_id=$${p++}`); params.push(req.user.id);
  } else if (req.user.role === 'oeil') {
    if (mode === 'available') {
      where.push(`m.status='pending' AND m.oeil_id IS NULL`);
    } else {
      where.push(`m.oeil_id=$${p++}`); params.push(req.user.id);
    }
  }
  if (status) { where.push(`m.status=$${p++}`); params.push(status); }
  if (type)   { where.push(`m.type=$${p++}`);   params.push(type); }

  const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { rows: missions } = await db.query(`
    SELECT m.*,
      c.first_name||' '||c.last_name AS client_name, c.phone AS client_phone,
      o.first_name||' '||o.last_name AS oeil_name,   o.phone AS oeil_phone,
      (SELECT COUNT(*) FROM mission_media WHERE mission_id=m.id)::int AS media_count,
      (SELECT COUNT(*) FROM mission_messages WHERE mission_id=m.id)::int AS message_count
    FROM missions m
    LEFT JOIN users c ON c.id=m.client_id
    LEFT JOIN users o ON o.id=m.oeil_id
    ${wc}
    ORDER BY m.created_at DESC
    LIMIT $${p++} OFFSET $${p++}
  `, [...params, limit, offset]);

  const { rows: [{ n: total }] } = await db.query(`SELECT COUNT(*)::int AS n FROM missions m ${wc}`, params);

  res.json({ missions, total, page: +page, pages: Math.ceil(total / limit) });
});

// ── POST /missions ─────────────────────────────────────────
router.post('/', authenticate, requireRole('client'), [
  body('type').isIn(['immobilier','file_attente','audit','personnalisee']),
  body('title').trim().isLength({ min: 3, max: 200 }),
  body('address').trim().notEmpty(),
  body('city').trim().notEmpty(),
  body('scheduled_at').isISO8601(),
  body('price').isFloat({ min: 50 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const {
    type, title, description, address, city, scheduled_at,
    duration_est, price, is_urgent, oeil_id,
    property_type, visit_type, video_call,
    institution, purpose,
    company_name, audit_type, frequency, criteria, subcategory,
  } = req.body;

  const id = uuidv4();
  const { commission, oeil_earning } = pricing(+price);

const status = oeil_id ? 'assigned' : 'pending';

const { rows: [mission] } = await db.query(`
  INSERT INTO missions (
    id,client_id,type,subcategory,status,title,description,address,city,scheduled_at,
    duration_est,price,commission,oeil_earning,is_urgent,
    property_type,visit_type,video_call,institution,purpose,
    company_name,audit_type,frequency,criteria,oeil_id
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
  RETURNING *
`, [
  id, req.user.id, type, subcategory||null, status, title, description||null, address, city,
  new Date(scheduled_at), duration_est||null, price, commission, oeil_earning,
  !!is_urgent, property_type||null, visit_type||null, !!video_call,
  institution||null, purpose||null, company_name||null, audit_type||null,
  frequency||null, criteria||null, oeil_id||null
]);

  // Notify verified available oeils
  const { rows: oeils } = await db.query(
    `SELECT u.id FROM users u JOIN oeil_profiles p ON p.user_id=u.id
     WHERE u.role='oeil' AND u.is_active=true AND p.is_verified=true AND p.is_available=true`
  );
  for (const o of oeils) {
    await notify(db, o.id, `Nouvelle mission${is_urgent?' 🚨 URGENTE':''}`,
      `${title} — ${city} · ${price} MAD`, 'mission', id, emitToUser);
  }

  // Broadcast to admin room
  io.to('room:admin').emit('new_mission', mission);

  res.status(201).json({ mission });
});

// ── GET /missions/:id ──────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  const db = getDb();
  const { rows: [mission] } = await db.query(`
    SELECT m.*,
      c.first_name||' '||c.last_name AS client_name, c.phone AS client_phone, c.email AS client_email,
      o.first_name||' '||o.last_name AS oeil_name,   o.phone AS oeil_phone,
      p.rating_avg AS oeil_rating, p.total_missions AS oeil_total_missions
    FROM missions m
    LEFT JOIN users c ON c.id=m.client_id
    LEFT JOIN users o ON o.id=m.oeil_id
    LEFT JOIN oeil_profiles p ON p.user_id=m.oeil_id
    WHERE m.id=$1
  `, [req.params.id]);

  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (req.user.role === 'client' && mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (req.user.role === 'oeil' && mission.oeil_id !== req.user.id && mission.status !== 'pending') return res.status(403).json({ error: 'Accès refusé' });

  const [{ rows: media }, { rows: messages }, { rows: [report] }, { rows: [rating] }] = await Promise.all([
    db.query('SELECT * FROM mission_media WHERE mission_id=$1 ORDER BY created_at DESC', [req.params.id]),
    db.query(`SELECT mm.*, u.first_name||' '||u.last_name AS sender_name, u.role AS sender_role
              FROM mission_messages mm JOIN users u ON u.id=mm.sender_id
              WHERE mm.mission_id=$1 ORDER BY mm.created_at ASC`, [req.params.id]),
    db.query('SELECT * FROM mission_reports WHERE mission_id=$1', [req.params.id]),
    db.query('SELECT * FROM ratings WHERE mission_id=$1', [req.params.id]),
  ]);

  // Mark messages as read
  await db.query(`UPDATE mission_messages SET is_read=true WHERE mission_id=$1 AND sender_id!=$2`, [req.params.id, req.user.id]);

  res.json({ mission, media, messages, report: report||null, rating: rating||null });
});

// ── POST /missions/:id/accept ──────────────────────────────
router.post('/:id/accept', authenticate, requireRole('oeil'), async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.status !== 'pending') return res.status(400).json({ error: 'Mission plus disponible' });

  const { rows: [profile] } = await db.query('SELECT is_verified FROM oeil_profiles WHERE user_id=$1', [req.user.id]);
  if (!profile?.is_verified) return res.status(403).json({ error: 'Profil non vérifié' });

  const { rows: [updated] } = await db.query(
    `UPDATE missions SET oeil_id=$1, status='assigned', assigned_at=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *`,
    [req.user.id, req.params.id]
  );

  const { rows: [oeil] } = await db.query('SELECT first_name, last_name FROM users WHERE id=$1', [req.user.id]);
  const oeilName = `${oeil.first_name} ${oeil.last_name}`;

  await notify(db, mission.client_id, 'Œil assigné 👁️', `${oeilName} a accepté "${mission.title}"`, 'mission', mission.id, emitToUser);
  await notify(db, req.user.id, 'Mission acceptée', `Vous avez accepté "${mission.title}"`, 'mission', mission.id, emitToUser);

  await db.query(`INSERT INTO mission_messages (mission_id,sender_id,content,type) VALUES ($1,$2,$3,'system')`,
    [mission.id, req.user.id, `${oeil.first_name} a accepté la mission.`]);

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status: 'assigned', oeil_name: oeilName });
  io.to('room:admin').emit('mission_updated', updated);

  res.json({ mission: updated });
});

// ── POST /missions/:id/refuse ──────────────────────────────
router.post('/:id/refuse', authenticate, requireRole('oeil'), async (req, res) => {
  const db = getDb();
  try {
    const { rows: [mission] } = await db.query(
      `UPDATE missions 
       SET status='pending', oeil_id=NULL, updated_at=NOW() 
       WHERE id=$1 AND oeil_id=$2 
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
    res.json({ mission });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /missions/:id/status ──────────────────────────────
router.post('/:id/status', authenticate, [
  body('status').isIn(['en_route','active','completed','cancelled']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  if (req.user.role === 'oeil' && mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (req.user.role === 'client' && mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });

  const transitions = {
  pending:  ['cancelled'],
  assigned: ['en_route', 'cancelled'],
  en_route: ['active',   'cancelled'],
  active:   ['completed','cancelled'],
};

  const { status, cancel_reason } = req.body;
  if (!transitions[mission.status]?.includes(status))
    return res.status(400).json({ error: `Transition invalide: ${mission.status} → ${status}` });

  const { rows: [updated] } = await db.query(`
    UPDATE missions SET
      status=$1,
      completed_at = CASE WHEN $1='completed' THEN NOW() ELSE completed_at END,
      cancelled_at = CASE WHEN $1='cancelled' THEN NOW() ELSE cancelled_at END,
      cancel_reason= CASE WHEN $1='cancelled' THEN $2 ELSE cancel_reason END,
      started_at   = CASE WHEN $1='active'    THEN NOW() ELSE started_at END,
      updated_at   = NOW()
    WHERE id=$3 RETURNING *
  `, [status, cancel_reason||null, mission.id]);

  // Credit oeil on completion
  if (status === 'completed' && mission.oeil_id) {
    await db.query(
      `UPDATE oeil_profiles SET balance=balance+$1, total_earnings=total_earnings+$1, total_missions=total_missions+1 WHERE user_id=$2`,
      [mission.oeil_earning, mission.oeil_id]
    );
    await notify(db, mission.client_id, 'Mission complétée ✅', `"${mission.title}" terminée. Notez votre Œil !`, 'mission', mission.id, emitToUser);
    await notify(db, mission.oeil_id, '💰 Paiement crédité', `${mission.oeil_earning} MAD sur votre solde.`, 'mission', mission.id, emitToUser);
  }

  const labels = { en_route:'en route', active:'démarrée', cancelled:'annulée', completed:'complétée' };
  const sysMsg = { en_route:"L'Œil est en route.", active:"Mission démarrée.", completed:"Mission terminée avec succès.", cancelled:"Mission annulée." };

  await db.query(`INSERT INTO mission_messages (mission_id,sender_id,content,type) VALUES ($1,$2,$3,'system')`,
    [mission.id, req.user.id, sysMsg[status]]);

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status });
  io.to('room:admin').emit('mission_updated', updated);

  res.json({ mission: updated });
});

// ── POST /missions/:id/location ────────────────────────────
router.post('/:id/location', authenticate, requireRole('oeil'), [
  body('lat').isFloat({ min: -90, max: 90 }),
  body('lng').isFloat({ min: -180, max: 180 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const { lat, lng } = req.body;
  await db.query(
    `UPDATE missions SET oeil_lat=$1, oeil_lng=$2, oeil_location_at=NOW() WHERE id=$3 AND oeil_id=$4`,
    [lat, lng, req.params.id, req.user.id]
  );
  // Also broadcast via socket
  req.app.get('io').to(`mission:${req.params.id}`).emit('location_update', { lat, lng, timestamp: new Date() });
  res.json({ lat, lng });
});

// ── POST /missions/:id/report ──────────────────────────────
router.post('/:id/report', authenticate, requireRole('oeil','admin'), [
  body('summary').trim().isLength({ min: 10 }),
  body('score').isInt({ min: 0, max: 100 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (req.user.role === 'oeil' && mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });

  const { summary, risk_points = [], score, notes } = req.body;
  const { rows: [report] } = await db.query(`
    INSERT INTO mission_reports (mission_id,summary,risk_points,score,notes,created_by)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (mission_id) DO UPDATE
    SET summary=$2, risk_points=$3, score=$4, notes=$5
    RETURNING *
  `, [mission.id, summary, JSON.stringify(risk_points), score, notes||null, req.user.id]);

  await notify(db, mission.client_id, '📄 Rapport disponible', `Le rapport de "${mission.title}" est prêt.`, 'report', mission.id, emitToUser);

  res.status(201).json({ report });
});

// ── POST /missions/:id/rate ────────────────────────────────
// ── POST /:id/messages ─────────────────────────────────
router.post('/:id/messages', authenticate, async (req, res) => {
  const db = getDb();
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Message vide' });

  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1', [req.params.id]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  // Vérifier que l'utilisateur est client ou oeil de cette mission
  const isClient = mission.client_id === req.user.id;
  const isOeil   = mission.oeil_id   === req.user.id;
  const isAdmin  = req.user.role === 'admin';
  if (!isClient && !isOeil && !isAdmin) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  const { rows: [msg] } = await db.query(
    `INSERT INTO mission_messages (mission_id, sender_id, content, type)
     VALUES ($1, $2, $3, 'text') RETURNING *`,
    [req.params.id, req.user.id, content.trim()]
  );

  // Notifier via Socket.io
  const io = req.app.get('io');
  if (io) {
    io.to(`mission:${req.params.id}`).emit('new_message', {
      ...msg,
      sender_role: req.user.role,
    });
  }
// Notification à l'autre partie
  const recipientId = req.user.id === mission.client_id 
    ? mission.oeil_id 
    : mission.client_id;

  if (recipientId) {
    await db.query(
  `INSERT INTO notifications (user_id, title, body, type, mission_id)
   VALUES ($1, 'Nouveau message', $2, 'message', $3)`,
  [recipientId, content.trim().slice(0, 80), req.params.id]
    );
    const emitToUser = req.app.get('emitToUser');
    if (emitToUser) {
      emitToUser(recipientId, 'notification', {
        title: 'Nouveau message',
        body: content.trim().slice(0, 80),
        missionId: req.params.id
      });
    }
  }
  res.status(201).json({ message: msg });
});

router.post('/:id/rate', authenticate, requireRole('client'), [
  body('score').isInt({ min: 1, max: 5 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (mission.status !== 'completed') return res.status(400).json({ error: 'Mission non complétée' });

  const existing = await db.query('SELECT id FROM ratings WHERE mission_id=$1', [req.params.id]);
  if (existing.rows.length) return res.status(409).json({ error: 'Déjà noté' });

  await db.query(`INSERT INTO ratings (mission_id,client_id,oeil_id,score,comment) VALUES ($1,$2,$3,$4,$5)`,
    [mission.id, req.user.id, mission.oeil_id, req.body.score, req.body.comment||null]);

  const { rows: [avg] } = await db.query('SELECT AVG(score)::numeric(3,1) AS a, COUNT(*)::int AS c FROM ratings WHERE oeil_id=$1', [mission.oeil_id]);
  await db.query('UPDATE oeil_profiles SET rating_avg=$1, rating_count=$2 WHERE user_id=$3', [avg.a, avg.c, mission.oeil_id]);

  await notify(db, mission.oeil_id, `Nouvelle note: ${req.body.score}/5 ⭐`, `"${mission.title}" notée par un client.`, 'rating', mission.id, emitToUser);

  res.status(201).json({ rating_avg: avg.a, rating_count: avg.c });
});

module.exports = router;
