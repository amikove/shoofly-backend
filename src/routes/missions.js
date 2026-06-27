const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');


async function getCommissionRate(db) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key='commission'")
  return rows.length ? parseFloat(rows[0].value) : 0.20
}

async function pricing(price, db) {
  const rate = await getCommissionRate(db)
  const commission = Math.round(price * rate * 100) / 100;
  return { commission, oeil_earning: price - commission };
}

async function notify(db, userId, title, body, type = 'info', missionId = null, emitToUser = null) {
  const r = await db.query(
    `INSERT INTO notifications (user_id,title,body,type,mission_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, title, body, type, missionId]
  );
  if (emitToUser) emitToUser(userId, 'notification', r.rows[0]);
}

async function logStatus(db, missionId, status, userId, note = null) {
  await db.query(
    `INSERT INTO mission_status_history (mission_id, status, changed_by, note) VALUES ($1, $2, $3, $4)`,
    [missionId, status, userId, note]
  );
}


// ── POST /missions/:id/validate ────────────────────────────
router.post('/:id/validate', authenticate, requireRole('client'), async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (mission.status !== 'completed') return res.status(400).json({ error: 'Mission non terminée' });
  if (mission.validated_at) return res.status(400).json({ error: 'Mission déjà validée' });

  await db.query(`UPDATE missions SET validated_at=NOW(), updated_at=NOW() WHERE id=$1`, [mission.id]);
  await db.query(`UPDATE oeil_profiles SET balance=balance+$1, total_earnings=total_earnings+$1 WHERE user_id=$2`, [mission.oeil_earning, mission.oeil_id]);
  await db.query(`INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,'Validation client',$3)`, [mission.oeil_id, mission.oeil_earning, mission.id]);

await notify(db, mission.oeil_id, '💰 Paiement reçu !', `Le client a validé "${mission.title}". ${mission.oeil_earning} MAD crédités.`, 'info', mission.id, emitToUser);
  await notify(db, mission.client_id, '✅ Mission validée', `Vous avez validé "${mission.title}".`, 'info', mission.id, emitToUser);
  await logStatus(db, mission.id, 'validated', req.user.id, 'Validée par le client');

  res.json({ ok: true });
});


// ── POST /missions/:id/claim ────────────────────────────────
router.post('/:id/claim', authenticate, async (req, res) => {
  const db = getDb();
  const { comment } = req.body;
  if (!comment?.trim()) return res.status(400).json({ error: 'Commentaire obligatoire' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (mission.status !== 'completed') return res.status(400).json({ error: 'Mission non terminée' });

  const hoursSinceCompletion = (Date.now() - new Date(mission.completed_by_oeil_at).getTime()) / 3600000;
  if (hoursSinceCompletion > 12) return res.status(400).json({ error: 'Délai de réclamation dépassé (12h)' });

  const emitToUser = req.app.get('emitToUser');


  await db.query(`UPDATE missions SET status='sous_reclamation', updated_at=NOW() WHERE id=$1`, [req.params.id]);
  await db.query(`INSERT INTO claims (mission_id, client_id, comment) VALUES ($1, $2, $3)`, [req.params.id, req.user.id, comment.trim()]);
  await logStatus(db, mission.id, 'sous_reclamation', req.user.id, 'Réclamation client');
  

  // Notifier les admins
  const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin'`);
  for (const admin of admins) {
    await notify(db, admin.id, '🚨 Nouvelle réclamation', `Mission "${mission.title}" contestée par le client.`, 'claim', req.params.id, emitToUser);
  }

  res.json({ ok: true });
});

// ── PUT /missions/:id/resolve-claim ────────────────────────
router.put('/:id/resolve-claim', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
  const db = getDb();
  const { decision } = req.body; // 'oeil' ou 'client'
  if (!['oeil','client'].includes(decision)) return res.status(400).json({ error: 'Décision invalide' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  const emitToUser = req.app.get('emitToUser');

  if (decision === 'oeil') {
    // Payer l'Œil
    await db.query(`UPDATE oeil_profiles SET balance=balance+$1, total_earnings=total_earnings+$1 WHERE user_id=$2`, [mission.oeil_earning, mission.oeil_id]);
    await db.query(`INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,'Mission validée après réclamation',$3)`, [mission.oeil_id, mission.oeil_earning, mission.id]);
    await db.query(`UPDATE missions SET status='completed', validated_at=NOW(), updated_at=NOW() WHERE id=$1`, [mission.id]);
    await db.query(`UPDATE claims SET status='resolved_oeil', resolved_by=$1, resolved_at=NOW() WHERE mission_id=$2`, [req.user.id, mission.id]);
    await notify(db, mission.oeil_id, '✅ Réclamation résolue', 'La réclamation a été résolue en votre faveur. Votre paiement a été crédité.', 'info', mission.id, emitToUser);
    await notify(db, mission.client_id, 'Réclamation résolue', 'La réclamation a été examinée et résolue en faveur de l\'Œil.', 'info', mission.id, emitToUser);
  } else {
    // Rembourser le client
    await db.query(`UPDATE users SET balance=balance+$1 WHERE id=$2`, [mission.price, mission.client_id]);
    await db.query(`INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,'Remboursement suite à réclamation',$3)`, [mission.client_id, mission.price, mission.id]);
    await db.query(`UPDATE missions SET status='cancelled', updated_at=NOW() WHERE id=$1`, [mission.id]);
    await db.query(`UPDATE claims SET status='resolved_client', resolved_by=$1, resolved_at=NOW() WHERE mission_id=$2`, [req.user.id, mission.id]);
    await notify(db, mission.client_id, '✅ Réclamation résolue', `${mission.price} MAD ont été crédités sur votre portefeuille.`, 'info', mission.id, emitToUser);
    await notify(db, mission.oeil_id, 'Réclamation résolue', 'La réclamation a été résolue en faveur du client.', 'info', mission.id, emitToUser);
  }

  res.json({ ok: true });
});

// ── GET /missions/:id/history ──────────────────────────────
router.get('/:id/history', authenticate, async (req, res) => {
  const db = getDb();
  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (req.user.role === 'client' && mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (req.user.role === 'oeil' && mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  const { rows } = await db.query(`
    SELECT h.*, u.first_name||' '||u.last_name AS changed_by_name, u.role AS changed_by_role
    FROM mission_status_history h
    LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.mission_id = $1
    ORDER BY h.created_at ASC
  `, [req.params.id]);
  res.json({ history: rows });
});

// ── GET /missions/inbox ─────────────────────────────────────
router.get('/inbox', authenticate, async (req, res) => {
  const db = getDb();
  const userId = req.user.id;

  const { rows } = await db.query(`
    SELECT
      m.id, m.title, m.type, m.status,
      c.first_name || ' ' || c.last_name AS client_name,
      o.first_name || ' ' || o.last_name AS oeil_name,
      last_msg.content                   AS last_message,
      last_msg.created_at                AS last_message_at,
      (
        SELECT COUNT(*) FROM mission_messages mm
        WHERE mm.mission_id = m.id
          AND mm.sender_id != $1
          AND mm.created_at > COALESCE(
            (SELECT seen_at FROM mission_chat_seen WHERE user_id=$1 AND mission_id=m.id),
            '1970-01-01'
          )
      )::int AS unread_count
    FROM missions m
    LEFT JOIN users c ON c.id = m.client_id
    LEFT JOIN users o ON o.id = m.oeil_id
    LEFT JOIN LATERAL (
      SELECT content, created_at FROM mission_messages
      WHERE mission_id = m.id
      ORDER BY created_at DESC LIMIT 1
    ) last_msg ON true
    WHERE (m.client_id = $1 OR m.oeil_id = $1)
      AND EXISTS (SELECT 1 FROM mission_messages WHERE mission_id = m.id)
    ORDER BY last_msg.created_at DESC NULLS LAST
  `, [userId]);

  res.json({ inbox: rows });
});


// ── POST /missions/:id/seen ─────────────────────────────────
router.post('/:id/seen', authenticate, async (req, res) => {
  const db = getDb();
  await db.query(`
    INSERT INTO mission_chat_seen (user_id, mission_id, seen_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (user_id, mission_id) DO UPDATE SET seen_at = NOW()
  `, [req.user.id, req.params.id]);
  res.json({ ok: true });
});


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

// placer les missions ignorées dans une table à part

    if (mode === 'available') {
  where.push(`m.status='pending' AND m.oeil_id IS NULL AND m.city=$${p++}`);
  params.push(req.user.city);

  if (req.query.quartier) {
    where.push(`m.quartier ILIKE $${p++}`);
    params.push(`%${req.query.quartier}%`);
  }

  // Exclure les missions ignorées
  where.push(`m.id NOT IN (SELECT mission_id FROM mission_ignored WHERE oeil_id=$${p++})`);
  params.push(req.user.id);
}



    
    else {
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
      (SELECT COUNT(*) FROM mission_messages WHERE mission_id=m.id)::int AS message_count,
      (SELECT COUNT(*) FROM mission_interests WHERE mission_id=m.id AND oeil_id='${req.user.id}')::int > 0 AS has_interested,
      (SELECT score FROM ratings WHERE mission_id=m.id LIMIT 1) AS rating_score,
      (SELECT comment FROM ratings WHERE mission_id=m.id LIMIT 1) AS rating_comment
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
  body('title').trim().isLength({ min: 6, max: 200 }),
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
    type, title, description, address, city, quartier, scheduled_at,
    duration_est, price, is_urgent, oeil_id,
    property_type, visit_type, video_call,
    institution, purpose,
    company_name, audit_type, frequency, criteria, subcategory,
  } = req.body;

  const id = uuidv4();
 const { commission, oeil_earning } = await pricing(+price, db);

const status = oeil_id ? 'assigned' : 'pending';

const { rows: [mission] } = await db.query(`
  INSERT INTO missions (
    id,client_id,type,subcategory,status,title,description,address,city,quartier,scheduled_at,
    duration_est,price,commission,oeil_earning,is_urgent,
    property_type,visit_type,video_call,institution,purpose,
    company_name,audit_type,frequency,criteria,oeil_id
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
  RETURNING *

`, [
  id, req.user.id, type, subcategory||null, status, title, description||null, address, city, quartier||null,
  new Date(scheduled_at), duration_est||null, price, commission, oeil_earning,
  !!is_urgent, property_type||null, visit_type||null, !!video_call,
  institution||null, purpose||null, company_name||null, audit_type||null,
  frequency||null, criteria||null, oeil_id||null
]);

await logStatus(db, mission.id, 'pending', req.user.id, 'Mission créée');

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
  await logStatus(db, req.params.id, 'assigned', req.user.id, 'Œil sélectionné par le client');

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



// ── GET /:id/interests ── Liste des Œils intéressés ────────
router.get('/:id/interests', authenticate, async (req, res) => {
  const db = getDb();

  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1', [req.params.id]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  // Seul le client de la mission ou un admin peut voir les intéressés
  if (mission.client_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  const { rows } = await db.query(
    `SELECT u.id, u.first_name, u.last_name, u.city,
            p.rating_avg, p.rating_count, p.total_missions, p.bio, p.coverage_zone,
            mi.message, mi.created_at as interested_at
     FROM mission_interests mi
     JOIN users u ON u.id = mi.oeil_id
     LEFT JOIN oeil_profiles p ON p.user_id = mi.oeil_id
     WHERE mi.mission_id = $1
     ORDER BY mi.created_at ASC`,
    [req.params.id]
  );

  res.json({ interests: rows });
});

-

// ── POST /missions/:id/refuse ──────────────────────────────
router.post('/:id/refuse', authenticate, requireRole('oeil'), async (req, res) => {
  const db = getDb();
  const { ignore } = req.body;
  try {
    if (ignore) {
      // Mission disponible — juste ignorer
      await db.query(
        `INSERT INTO mission_ignored (oeil_id, mission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [req.user.id, req.params.id]
      );
      return res.json({ ok: true });
    }
    // Mission assignée — refuser
    const { rows: [mission] } = await db.query(
      `UPDATE missions SET status='pending', oeil_id=NULL, updated_at=NOW() WHERE id=$1 AND oeil_id=$2 RETURNING *`,
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

  // Bloquer si rapport non soumis pour audit ou airbnb
  if (status === 'completed' && req.user.role === 'oeil') {
    const isAudit  = mission.type === 'audit'
    const isAirbnb = mission.subcategory && ['airbnb','booking'].some(s => mission.subcategory.toLowerCase().includes(s.toLowerCase()))
    if (isAudit || isAirbnb) {
      const { rows: [report] } = await db.query(
        `SELECT * FROM airbnb_reports WHERE mission_id=$1 AND submitted=true`,
        [mission.id]
      )
      if (!report) {
        return res.status(400).json({ error: 'Vous devez soumettre le rapport avant de terminer la mission' })
      }
    }
  }

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

  // Logger le changement de statut (sauf completed géré plus bas)
  if (status !== 'completed') {
    await logStatus(db, mission.id, status, req.user.id, null);
  }

  // Remboursement si annulation par le client
  if (status === 'cancelled' && req.user.role === 'client' && mission.status === 'assigned') {
    const hoursBeforeMission = (new Date(mission.scheduled_at).getTime() - Date.now()) / 3600000
    if (hoursBeforeMission > 2) {
      // Remboursement 50%
      const refund = Math.round(mission.price * 0.5 * 100) / 100
      await db.query(`UPDATE users SET balance=balance+$1 WHERE id=$2`, [refund, mission.client_id])
      await db.query(`INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,'Remboursement annulation (50%)',$3)`, [mission.client_id, refund, mission.id])
      await notify(db, mission.client_id, '💰 Remboursement partiel', `${refund} MAD crédités sur votre portefeuille suite à l'annulation.`, 'info', mission.id, emitToUser)
      await notify(db, mission.oeil_id, 'Mission annulée', `La mission "${mission.title}" a été annulée par le client.`, 'info', mission.id, emitToUser)
    } else {
      // Aucun remboursement
      await notify(db, mission.client_id, 'Mission annulée', `Annulation dans les 2h — aucun remboursement conformément aux CGV.`, 'info', mission.id, emitToUser)
      await notify(db, mission.oeil_id, 'Mission annulée', `La mission "${mission.title}" a été annulée par le client.`, 'info', mission.id, emitToUser)
    }
  }

  // Remboursement intégral si annulation avant assignation
  if (status === 'cancelled' && req.user.role === 'client' && mission.status === 'pending') {
    await db.query(`UPDATE users SET balance=balance+$1 WHERE id=$2`, [mission.price, mission.client_id])
    await db.query(`INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,'Remboursement annulation avant assignation',$3)`, [mission.client_id, mission.price, mission.id])
    await notify(db, mission.client_id, '💰 Remboursement intégral', `${mission.price} MAD crédités sur votre portefeuille.`, 'info', mission.id, emitToUser)
  }



// Oeil marque terminée → démarrer le délai de 12h pour réclamation

  if (status === 'completed' && mission.oeil_id) {
    await db.query(
      `UPDATE missions SET completed_by_oeil_at=NOW() WHERE id=$1`,
      [mission.id]
    );
    await logStatus(db, mission.id, 'completed', req.user.id, 'Mission terminée par l\'Œil');
    await db.query(
      `UPDATE oeil_profiles SET total_missions=total_missions+1 WHERE user_id=$1`,
      [mission.oeil_id]
    );
    await notify(db, mission.client_id, 'Mission terminée ✅', `"${mission.title}" est terminée. Vous avez 12h pour réclamer si nécessaire.`, 'mission', mission.id, emitToUser);
    await notify(db, mission.oeil_id, 'Mission terminée', `"${mission.title}" marquée comme terminée. Paiement en attente de validation.`, 'mission', mission.id, emitToUser);
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

const cleanContent = content.trim()

// Détection de contenu sensible
function detectSensitiveContent(text) {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[.\-_\/\\|]/g, '')
    .replace(/zero/g, '0').replace(/zéro/g, '0')
    .replace(/un/g, '1').replace(/deux/g, '2')
    .replace(/trois/g, '3').replace(/quatre/g, '4')
    .replace(/cinq/g, '5').replace(/six/g, '6')
    .replace(/sept/g, '7').replace(/huit/g, '8')
    .replace(/neuf/g, '9')

  const patterns = [
    /0[567]\d{8}/,
    /\+212\d{9}/,
    /\d{10}/,
    /@(gmail|hotmail|yahoo|outlook|live|icloud)/,
    /(whatsapp|telegram|instagram|facebook|tiktok|snapchat|signal)/,
    /(http|www\.|\.com|\.ma|\.net|\.org)/,
  ]
  return patterns.some(p => p.test(normalized))
}

const isFlagged = detectSensitiveContent(cleanContent)

const { rows: [msg] } = await db.query(
  `INSERT INTO mission_messages (mission_id, sender_id, content, type, is_flagged)
   VALUES ($1, $2, $3, 'text', $4) RETURNING *`,
  [req.params.id, req.user.id, cleanContent, isFlagged]
);

// Notifier l'admin si message suspect
if (isFlagged) {
  const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin'`)
  const sender = await db.query('SELECT first_name, last_name FROM users WHERE id=$1', [req.user.id])
  const senderName = `${sender.rows[0]?.first_name} ${sender.rows[0]?.last_name}`
  for (const admin of admins) {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, mission_id)
       VALUES ($1, $2, $3, 'warning', $4)`,
      [admin.id, '⚠️ Message suspect détecté',
       `${senderName} a peut-être partagé un contact externe dans la mission "${mission.title}"`,
       req.params.id]
    )
    const emitToUser = req.app.get('emitToUser')
    if (emitToUser) emitToUser(admin.id, 'notification', {
      title: '⚠️ Message suspect détecté',
      body: `${senderName} — mission "${mission.title}"`,
      missionId: req.params.id
    })
  }
}

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
    const notifBody = `${mission.title} : ${content.trim().slice(0, 60)}`
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, mission_id)
      VALUES ($1, 'Nouveau message', $2, 'message', $3)`,
      [recipientId, notifBody, req.params.id]
    );
    const emitToUser = req.app.get('emitToUser');
    if (emitToUser) {
      emitToUser(recipientId, 'notification', {
        title: 'Nouveau message',
        body: notifBody,
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

// ── POST /:id/interest ── Œil exprime son intérêt ─────────

router.post('/:id/interest', authenticate, requireRole('oeil'), async (req, res) => {
  const db = getDb();
  const { message } = req.body;

  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1', [req.params.id]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.status !== 'pending') return res.status(400).json({ error: 'Mission non disponible' });

  // Vérifier les conflits de créneau
  const { rows: conflicts } = await db.query(`
    SELECT m.id, m.title, m.scheduled_at FROM missions m
    WHERE m.oeil_id = $1
      AND m.status IN ('assigned','en_route','active')
      AND ABS(EXTRACT(EPOCH FROM (m.scheduled_at - $2)) / 3600) < 4
  `, [req.user.id, mission.scheduled_at])

  if (conflicts.length > 0) {
    return res.status(400).json({ error: 'Vous avez déjà une mission dans le même créneau.' })
  }

  await db.query(
    `INSERT INTO mission_interests (mission_id, oeil_id, message)
     VALUES ($1, $2, $3) ON CONFLICT (mission_id, oeil_id) DO NOTHING`,
    [req.params.id, req.user.id, message || null]
  );

  const emitToUser = req.app.get('emitToUser');
  const notifBody = `Un Œil est intéressé par votre mission : ${mission.title}`
  await notify(db, mission.client_id, 'Nouvel Œil intéressé 👁️', notifBody, 'interest', req.params.id, emitToUser);

  res.status(201).json({ ok: true });
});



// ── POST /:id/hire/:oeilId ── Client choisit un Œil ───────
router.post('/:id/hire/:oeilId', authenticate, requireRole('client'), async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1 AND client_id=$2',
    [req.params.id, req.user.id]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.status !== 'pending') return res.status(400).json({ error: 'Mission non disponible' });

  const { rows: [interest] } = await db.query(
    'SELECT * FROM mission_interests WHERE mission_id=$1 AND oeil_id=$2',
    [req.params.id, req.params.oeilId]
  );
  if (!interest) return res.status(400).json({ error: "Cet Œil n'a pas exprimé son intérêt" });

  const { rows: [updated] } = await db.query(
    `UPDATE missions SET oeil_id=$1, status='assigned', assigned_at=NOW(), updated_at=NOW()
     WHERE id=$2 RETURNING *`,
    [req.params.oeilId, req.params.id]
  );

  // Re-vérifier le créneau avant assignation
  const { rows: creneauConflicts } = await db.query(`
    SELECT m.id FROM missions m
    WHERE m.oeil_id = $1
      AND m.status IN ('assigned','en_route','active')
      AND m.id != $2
      AND ABS(EXTRACT(EPOCH FROM (m.scheduled_at - $3)) / 3600) < 4
  `, [req.params.oeilId, req.params.id, mission.scheduled_at])

  if (creneauConflicts.length > 0) {
    return res.status(400).json({ error: 'Cet Œil a déjà une mission dans le même créneau.' })
  }

  // Supprimer les intérêts en conflit de créneau
  const { rows: conflictInterests } = await db.query(`
    SELECT mi.mission_id FROM mission_interests mi
    JOIN missions m ON m.id = mi.mission_id
    WHERE mi.oeil_id = $1
      AND mi.mission_id != $2
      AND m.status = 'pending'
      AND ABS(EXTRACT(EPOCH FROM (m.scheduled_at - $3)) / 3600) < 4
  `, [req.params.oeilId, req.params.id, mission.scheduled_at])

  for (const ci of conflictInterests) {
    await db.query(
      `DELETE FROM mission_interests WHERE oeil_id=$1 AND mission_id=$2`,
      [req.params.oeilId, ci.mission_id]
    )
  }



  // Notifier l'Œil embauché
  await notify(db, req.params.oeilId, '🎉 Vous avez été sélectionné !',
    `Le client vous a choisi pour : ${mission.title}`, 'hired', req.params.id, emitToUser);

  // Notifier les Œils non retenus
  const { rows: others } = await db.query(
    'SELECT oeil_id FROM mission_interests WHERE mission_id=$1 AND oeil_id!=$2',
    [req.params.id, req.params.oeilId]
  );
  for (const o of others) {
    await notify(db, o.oeil_id, 'Mission pourvue',
      `"${mission.title}" a été attribuée à un autre Œil.`, 'info', req.params.id, emitToUser);
  }

  if (io) io.to('room:admin').emit('mission_assigned', updated);

  res.json({ mission: updated });
});

module.exports = router;
