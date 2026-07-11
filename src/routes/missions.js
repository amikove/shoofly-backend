const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');
const { logReliabilityEvent } = require('../utils/reliabilityScore');
const { refundOnCancellation } = require('../utils/refund');
const asyncHandler = require('../middleware/asyncHandler');


async function getCommissionRate(db) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key='commission'")
  return rows.length ? parseFloat(rows[0].value) : 0.20
}

async function pricing(price, db) {
  const rate = await getCommissionRate(db)
  const commission = Math.round(price * rate * 100) / 100;
  return { commission, oeil_earning: price - commission };
}

async function notify(db, userId, title, body, type = 'info', missionId = null, emitToUser = null, actionType = null, titleKey = null, bodyKey = null, params = null) {
  const r = await db.query(
    `INSERT INTO notifications (user_id,title,body,type,mission_id,action_type,title_key,body_key,params) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [userId, title, body, type, missionId, actionType, titleKey, bodyKey, params ? JSON.stringify(params) : null]
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
router.post('/:id/validate', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (mission.status !== 'completed') return res.status(400).json({ error: 'Mission non terminée' });
  if (mission.validated_at) return res.status(400).json({ error: 'Mission déjà validée' });

  await db.query(`UPDATE missions SET validated_at=NOW(), updated_at=NOW() WHERE id=$1`, [mission.id]);
 
  if (mission.transfer_type === 'during' && mission.transferred_from && mission.oeil2_id) {
    // Split 50/50
    const half = Math.round(mission.oeil_earning * 0.5 * 100) / 100;
    await db.query(`UPDATE oeil_profiles SET balance=balance+$1, total_earnings=total_earnings+$1 WHERE user_id=$2`, [half, mission.transferred_from]);
    await db.query(`UPDATE oeil_profiles SET balance=balance+$1, total_earnings=total_earnings+$1 WHERE user_id=$2`, [half, mission.oeil_id]);
    await db.query(`INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,'Part mission — transfert (50%)',$3)`, [mission.transferred_from, half, mission.id]);
    await db.query(`INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,'Part mission — transfert (50%)',$3)`, [mission.oeil_id, half, mission.id]);
    await notify(db, mission.transferred_from, '💰 Paiement partiel reçu', `${half} MAD crédités — votre part du transfert de "${mission.title}".`, 'info', mission.id, emitToUser, null, 'partialPaymentReceivedTitle', 'partialPaymentReceivedBody', {amount: half, missionTitle: mission.title});
  } else {
    await db.query(`UPDATE oeil_profiles SET balance=balance+$1, total_earnings=total_earnings+$1 WHERE user_id=$2`, [mission.oeil_earning, mission.oeil_id]);
    await db.query(`INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,'Validation client',$3)`, [mission.oeil_id, mission.oeil_earning, mission.id]);
  }

await notify(db, mission.oeil_id, '💰 Paiement reçu !', `Le client a validé "${mission.title}". ${mission.oeil_earning} MAD crédités.`, 'info', mission.id, emitToUser, null, 'paymentReceivedOeilTitle', 'paymentReceivedOeilBody', {missionTitle: mission.title, amount: mission.oeil_earning});
  await notify(db, mission.client_id, '✅ Mission validée', `Vous avez validé "${mission.title}".`, 'info', mission.id, emitToUser, null, 'missionValidatedClientTitle', 'missionValidatedClientBody', {missionTitle: mission.title});
  await logStatus(db, mission.id, 'validated', req.user.id, 'Validée par le client');

  res.json({ ok: true });
}));


// ── POST /missions/:id/claim ────────────────────────────────
router.post('/:id/claim', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { comment } = req.body;
  if (!comment?.trim()) return res.status(400).json({ error: 'Commentaire obligatoire' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (mission.validated_at) return res.status(400).json({ error: 'Cette mission a déjà été validée, aucune réclamation n\'est plus possible.' });
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
    await notify(db, admin.id, '🚨 Nouvelle réclamation', `Mission "${mission.title}" contestée par le client.`, 'claim', req.params.id, emitToUser, null, 'newClaimAdminTitle', 'newClaimAdminBody', {missionTitle: mission.title});
  }

  res.json({ ok: true });
}));

// ── PUT /missions/:id/resolve-claim ────────────────────────
router.put('/:id/resolve-claim', authenticate, asyncHandler(async (req, res) => {
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
    await db.query(`UPDATE missions SET status='completed', validated_at=NOW(), is_priority=false, updated_at=NOW() WHERE id=$1`, [mission.id]);
    await db.query(`UPDATE claims SET status='resolved_oeil', resolved_by=$1, resolved_at=NOW() WHERE mission_id=$2`, [req.user.id, mission.id]);
    await notify(db, mission.oeil_id, '✅ Réclamation résolue', 'La réclamation a été résolue en votre faveur. Votre paiement a été crédité.', 'info', mission.id, emitToUser, null, 'claimResolvedOeilWinTitle', 'claimResolvedOeilWinBody', null);
    await notify(db, mission.client_id, 'Réclamation résolue', 'La réclamation a été examinée et résolue en faveur de l\'Œil.', 'info', mission.id, emitToUser, null, 'claimResolvedClientLoseTitle', 'claimResolvedClientLoseBody', null);
  } else {
    // Rembourser le client — réclamation gagnée, non imputable au client : remboursement intégral
    const refund = await refundOnCancellation(db, mission, false, 'Remboursement suite à réclamation');
    await db.query(`UPDATE missions SET status='cancelled', is_priority=false, updated_at=NOW() WHERE id=$1`, [mission.id]);
    await db.query(`UPDATE claims SET status='resolved_client', resolved_by=$1, resolved_at=NOW() WHERE mission_id=$2`, [req.user.id, mission.id]);
    await notify(db, mission.client_id, '✅ Réclamation résolue', `${refund} MAD ont été crédités sur votre portefeuille.`, 'info', mission.id, emitToUser, null, 'claimResolvedOeilWinTitle', 'claimResolvedClientWinBody', {amount: refund});
    await notify(db, mission.oeil_id, 'Réclamation résolue', 'La réclamation a été résolue en faveur du client.', 'info', mission.id, emitToUser, null, 'claimResolvedClientLoseTitle', 'claimResolvedOeilLoseBody', null);
  }

  res.json({ ok: true });
}));

// ── GET /missions/:id/history ──────────────────────────────
router.get('/:id/history', authenticate, asyncHandler(async (req, res) => {
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
}));

// ── GET /missions/inbox ─────────────────────────────────────
router.get('/inbox', authenticate, asyncHandler(async (req, res) => {
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
}));


// ── POST /missions/:id/seen ─────────────────────────────────
router.post('/:id/seen', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  await db.query(`
    INSERT INTO mission_chat_seen (user_id, mission_id, seen_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (user_id, mission_id) DO UPDATE SET seen_at = NOW()
  `, [req.user.id, req.params.id]);
  res.json({ ok: true });
}));


// ── GET /missions ──────────────────────────────────────────
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { status, type, mode, search, page = 1, limit = 20, sort = 'created_desc' } = req.query;
  const offset = (page - 1) * limit;

  const ORDER = {
      created_desc:   'm.created_at DESC',
      created_asc:    'm.created_at ASC',
      scheduled_asc:  'm.scheduled_at ASC NULLS LAST',
      scheduled_desc: 'm.scheduled_at DESC NULLS LAST',
      deadline_asc:   'm.transfer_deadline ASC NULLS LAST',
      deadline_desc:  'm.transfer_deadline DESC NULLS LAST',
      title_asc:      'm.title ASC',
      title_desc:     'm.title DESC',
      client_asc:     'c.first_name ASC, c.last_name ASC',
      client_desc:    'c.first_name DESC, c.last_name DESC',
      oeil_asc:       'o.first_name ASC, o.last_name ASC',
      oeil_desc:      'o.first_name DESC, o.last_name DESC',
      price_asc:      'm.price ASC',
      price_desc:     'm.price DESC',
      status_asc:     'm.status ASC',
      status_desc:    'm.status DESC',
    }
  const orderBy = ORDER[sort] || 'm.created_at DESC';

  let where = [], params = [];
  let p = 1;

  if (req.user.role === 'client') {
    where.push(`m.client_id=$${p++}`); params.push(req.user.id);
  } else if (req.user.role === 'oeil') {
    // Un Œil suspendu ne doit voir aucune mission disponible, peu importe le mode
    const { rows: [suspensionCheck] } = await db.query('SELECT is_suspended FROM users WHERE id=$1', [req.user.id]);
    if (suspensionCheck?.is_suspended) {
      return res.json({ missions: [], total: 0, page: +page, pages: 0 });
    }
// placer les missions ignorées dans une table à part
    if (mode === 'available') {
      where.push(`m.status='pending' AND m.oeil_id IS NULL AND m.city=$${p++}`);
      params.push(req.user.city);

      if (req.query.quartier) {
        where.push(`m.quartier ILIKE $${p++}`);
        params.push(`%${req.query.quartier}%`);
      }

      // Filtre is_priority
      if (req.query.is_priority === 'true') {
        where.push(`m.is_priority=true`);
      } else {
        where.push(`m.is_priority=false`);
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
    if (search) {
      // Recherche sur : référence (fin de l'id), titre de mission, nom client, nom Œil
      where.push(`(
        m.id::text ILIKE $${p}
        OR m.title ILIKE $${p}
        OR (c.first_name || ' ' || c.last_name) ILIKE $${p}
        OR (o.first_name || ' ' || o.last_name) ILIKE $${p}
      )`);
      params.push(`%${search}%`);
      p++;
    }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';


  const { rows: missions } = await db.query(`
      SELECT m.*,
        c.first_name||' '||c.last_name AS client_name, c.phone AS client_phone, c.avatar_url AS client_avatar,
        o.first_name||' '||o.last_name AS oeil_name,   o.phone AS oeil_phone,   o.avatar_url AS oeil_avatar,
        (SELECT COUNT(*) FROM mission_media WHERE mission_id=m.id)::int AS media_count,
        (SELECT COUNT(*) FROM mission_messages WHERE mission_id=m.id)::int AS message_count,
        (SELECT COUNT(*) FROM mission_interests WHERE mission_id=m.id AND oeil_id='${req.user.id}')::int > 0 AS has_interested,
        (SELECT score FROM ratings WHERE mission_id=m.id LIMIT 1) AS rating_score,
        (SELECT comment FROM ratings WHERE mission_id=m.id LIMIT 1) AS rating_comment
      FROM missions m
      LEFT JOIN users c ON c.id=m.client_id
      LEFT JOIN users o ON o.id=m.oeil_id
      ${wc}
      ORDER BY ${orderBy}
      LIMIT $${p++} OFFSET $${p++}
    `, [...params, limit, offset]);




  const { rows: [{ n: total }] } = await db.query(`
      SELECT COUNT(*)::int AS n
      FROM missions m
      LEFT JOIN users c ON c.id=m.client_id
      LEFT JOIN users o ON o.id=m.oeil_id
      ${wc}
    `, params);

  res.json({ missions, total, page: +page, pages: Math.ceil(total / limit) });
}));

// ── POST /missions ─────────────────────────────────────────
router.post('/', authenticate, requireRole('client'), [
  body('type').isIn(['immobilier','file_attente','audit','personnalisee']),
  body('title').trim().isLength({ min: 6, max: 200 }),
  body('address').trim().notEmpty(),
  body('city').trim().notEmpty(),
  body('scheduled_at').isISO8601(),
  body('price').isFloat({ min: 0 }),
], asyncHandler(async (req, res) => {
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
    promo_code, discount, original_price, platform_amount,
  } = req.body;

const id = uuidv4();
  let { commission, oeil_earning } = await pricing(+original_price || +price, db);

  // Si code promo gratuit — Shoofly paie l'Œil
  if (promo_code && +price === 0 && platform_amount) {
    oeil_earning = parseFloat(platform_amount);
    commission   = 0;
  }

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

// Mission offerte via code promo gratuit : Shoofly paie l'Œil de sa poche, sans commission générée.
// On enregistre ce coût comme une dépense pour qu'il reste visible dans le Dashboard Financier.
if (promo_code && +price === 0 && platform_amount) {
  await db.query(
    `INSERT INTO expenses (amount, category, description, expense_date, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [parseFloat(platform_amount), 'Promotions', `[Généré automatiquement] Mission offerte "${title}" — code promo ${promo_code}`, new Date().toISOString().slice(0, 10), null]
  );
}

await logStatus(db, mission.id, 'pending', req.user.id, 'Mission créée');

// Enregistrer l'utilisation du code promo

  if (promo_code) {
    const { rows: [promo] } = await db.query(
      `SELECT id FROM promo_codes WHERE UPPER(code)=UPPER($1)`, [promo_code]
    );
    if (promo) {
      await db.query(
        `INSERT INTO promo_uses (promo_id, user_id, mission_id, discount) VALUES ($1,$2,$3,$4)`,
        [promo.id, req.user.id, mission.id, discount || 0]
      );
      await db.query(
        `UPDATE promo_codes SET used_count=used_count+1 WHERE id=$1`, [promo.id]
      );
    }
  }

  // Notify verified available oeils
  const { rows: oeils } = await db.query(
    `SELECT u.id FROM users u JOIN oeil_profiles p ON p.user_id=u.id
     WHERE u.role='oeil' AND u.is_active=true AND p.is_verified=true AND p.is_available=true`
  );
  for (const o of oeils) {
    await notify(db, o.id, `Nouvelle mission${is_urgent?' 🚨 URGENTE':''}`,
      `${title} — ${city} · ${price} MAD`, 'mission', id, emitToUser, null,
      is_urgent ? 'newMissionUrgentTitle' : 'newMissionAvailableTitle', 'newMissionBody', {missionTitle: title, city, price});
  }

  // Broadcast to admin room
  io.to('room:admin').emit('new_mission', mission);

  res.status(201).json({ mission });
}));





// ── GET /missions/my-reports — le rapporteur consulte l'historique de ses signalements ──
// IMPORTANT : cette route doit rester déclarée AVANT /:id, sinon Express interprète "my-reports" comme un id de mission
router.get('/my-reports', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`
    SELECT r.*,
      m.title AS mission_title, m.city, m.scheduled_at
    FROM mission_problem_reports r
      JOIN missions m ON m.id = r.mission_id
      WHERE r.reporter_id=$1
      ORDER BY r.created_at DESC
  `, [req.user.id]);

  res.json({ reports: rows });
}));

// ── GET /missions/:id ──────────────────────────────────
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
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
}));

// ── POST /missions/:id/accept ──────────────────────────────



router.post('/:id/accept', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.status !== 'pending') return res.status(400).json({ error: 'Mission plus disponible' });

  const { rows: [profile] } = await db.query('SELECT is_verified FROM oeil_profiles WHERE user_id=$1', [req.user.id]);
  if (!profile?.is_verified) return res.status(403).json({ error: 'Profil non vérifié' });

  
  const { rows: [updated] } = await db.query(
    `UPDATE missions SET
        oeil_id=$1,
        oeil2_id=CASE WHEN is_priority=true AND transferred_from IS NOT NULL THEN $1 ELSE oeil2_id END,
        status='assigned',
        assigned_at=NOW(),
        is_priority=false,
        transfer_deadline=NULL,
        updated_at=NOW()
      WHERE id=$2 RETURNING *`,
    [req.user.id, req.params.id]
  );

  await logStatus(db, req.params.id, 'assigned', req.user.id, 'Œil sélectionné par le client');

  const { rows: [oeil] } = await db.query('SELECT first_name, last_name FROM users WHERE id=$1', [req.user.id]);
  const oeilName = `${oeil.first_name} ${oeil.last_name}`;

  await notify(db, mission.client_id, 'Œil assigné 👁️', `${oeilName} a accepté "${mission.title}"`, 'mission', mission.id, emitToUser, null, 'oeilAssignedTitle', 'oeilAssignedBody', {oeilName, missionTitle: mission.title});
  await notify(db, req.user.id, 'Mission acceptée', `Vous avez accepté "${mission.title}"`, 'mission', mission.id, emitToUser, null, 'missionAcceptedOeilTitle', 'missionAcceptedOeilBody', {missionTitle: mission.title});

  await db.query(`INSERT INTO mission_messages (mission_id,sender_id,content,type,content_key,params) VALUES ($1,$2,$3,'system',$4,$5)`,
    [mission.id, req.user.id, `${oeil.first_name} a accepté la mission.`, 'oeilAccepted', JSON.stringify({ oeilName: oeil.first_name })]);

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status: 'assigned', oeil_name: oeilName });
  io.to('room:admin').emit('mission_updated', updated);

  res.json({ mission: updated });
}));



// ── GET /:id/interests ── Liste des Œils intéressés ────────
router.get('/:id/interests', authenticate, asyncHandler(async (req, res) => {
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
      `SELECT u.id, u.first_name, u.last_name, u.city, u.avatar_url,
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
  }));



// ── POST /missions/:id/refuse ──────────────────────────────
router.post('/:id/refuse', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
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

      // Pénalité de fiabilité proportionnelle au délai avant la mission :
        // plus le refus est tardif, plus il désorganise le client et pèse sur la réputation de la plateforme.
        const hoursBeforeMission = mission.scheduled_at
          ? (new Date(mission.scheduled_at).getTime() - Date.now()) / 3600000
          : null;
        let penaltyPoints, penaltyReason;
        if (hoursBeforeMission === null || hoursBeforeMission > 24) {
          penaltyPoints = -15;
          penaltyReason = 'Mission assignée refusée par l\'Œil (plus de 24h avant)';
        } else if (hoursBeforeMission > 2) {
          penaltyPoints = -35;
          penaltyReason = 'Mission assignée refusée par l\'Œil (entre 2h et 24h avant)';
        } else {
          penaltyPoints = -50;
          penaltyReason = 'Mission assignée refusée par l\'Œil (moins de 2h avant, très tardif)';
        }
        await logReliabilityEvent(db, req.user.id, mission.id, penaltyPoints, penaltyReason, penaltyPoints <= -35);
        // Cooldown de 4h : empêche l'Œil d'accepter immédiatement une autre mission après avoir abandonné celle-ci
        await db.query(
          `UPDATE users SET transfer_cooldown_until=NOW() + INTERVAL '4 hours' WHERE id=$1`,
          [req.user.id]
        );
        res.json({ mission });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}));




// ── POST /missions/:id/status ──────────────────────────────
router.post('/:id/status', authenticate, [
  body('status').isIn(['en_route','active','completed','cancelled']),
], asyncHandler(async (req, res) => {
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
        is_priority  = CASE WHEN $1 IN ('cancelled','completed') THEN false ELSE is_priority END,
        updated_at   = NOW()
      WHERE id=$3 RETURNING *
  `, [status, cancel_reason||null, mission.id]);

  // Logger le changement de statut (sauf completed géré plus bas)
  if (status !== 'completed') {
    await logStatus(db, mission.id, status, req.user.id, null);
  }

  // Remboursement en cas d'annulation — dépend de QUI est à l'origine de l'annulation,
  // pas seulement du timing. Le client n'a rien à se reprocher si l'annulation est
  // causée par l'Œil ou décidée par un admin pour une raison hors faute du client. l'admine a quand meme le choix de decider qui est respnsable et le montant
  if (status === 'cancelled') {
    let refund;
    // Un admin peut fixer un pourcentage de remboursement précis, en dérogation à la règle automatique
    if (req.user.role === 'admin' && req.body.refund_percent !== undefined) {
      const pct = Math.max(0, Math.min(parseFloat(req.body.refund_percent) || 0, 100));
      refund = Math.round(mission.price * pct / 100 * 100) / 100;
      if (refund > 0) {
        await db.query(`UPDATE users SET balance=balance+$1 WHERE id=$2`, [refund, mission.client_id]);
        await db.query(
          `INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,$3,$4)`,
          [mission.client_id, refund, 'Remboursement — montant fixé par l\'administrateur', mission.id]
        );
      }
      await notify(db, mission.client_id, '💰 Remboursement', `${refund} MAD crédités sur votre portefeuille suite à l'annulation de "${mission.title}".`, 'info', mission.id, emitToUser, null, 'fullRefundTitle', 'fullRefundBody', {amount: refund});
      if (mission.oeil_id) {
        await notify(db, mission.oeil_id, 'Mission annulée', `La mission "${mission.title}" a été annulée.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledByClientBody', {missionTitle: mission.title});
      }
    } else {
      // Le client est traité comme "à l'origine" de l'annulation dans 2 cas :
      // 1) c'est lui-même qui annule, 2) un admin annule en précisant que la faute lui revient
      const initiatedByClient = req.user.role === 'client'
        || (req.user.role === 'admin' && req.body.client_at_fault === true);
      refund = await refundOnCancellation(db, mission, initiatedByClient);

    if (initiatedByClient) {
      if (!mission.oeil_id) {
        await notify(db, mission.client_id, '💰 Remboursement intégral', `${refund} MAD crédités sur votre portefeuille.`, 'info', mission.id, emitToUser, null, 'fullRefundTitle', 'fullRefundBody', {amount: refund});
      } else if (refund > 0) {
        await notify(db, mission.client_id, '💰 Remboursement partiel', `${refund} MAD crédités sur votre portefeuille suite à l'annulation.`, 'info', mission.id, emitToUser, null, 'partialRefundTitle', 'partialRefundBody', {amount: refund});
      } else {
        await notify(db, mission.client_id, 'Mission annulée', `Annulation dans les 2h — aucun remboursement conformément aux CGV.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledNoRefundBody', null);
      }
      if (mission.oeil_id) {
        await notify(db, mission.oeil_id, 'Mission annulée', `La mission "${mission.title}" a été annulée par le client.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledByClientBody', {missionTitle: mission.title});
      }
    } else {
      await notify(db, mission.client_id, '💰 Remboursement intégral', `${refund} MAD crédités sur votre portefeuille suite à l'annulation de "${mission.title}".`, 'info', mission.id, emitToUser, null, 'fullRefundTitle', 'fullRefundBody', {amount: refund});
      if (mission.oeil_id && mission.oeil_id !== req.user.id) {
        await notify(db, mission.oeil_id, 'Mission annulée', `La mission "${mission.title}" a été annulée.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledByClientBody', {missionTitle: mission.title});
      }
    }
    }

    // Fermer automatiquement tout signalement encore ouvert lié à cette mission —
    // la mission étant annulée, le problème signalé est désormais sans objet.
    await db.query(
      `UPDATE mission_problem_reports SET status='resolved', admin_note=COALESCE(admin_note, 'Résolu automatiquement suite à l''annulation de la mission'), resolved_by=$1, resolved_at=NOW()
         WHERE mission_id=$2 AND status IN ('open','in_progress')`,
      [req.user.id, mission.id]
    );
    await db.query(`UPDATE missions SET under_surveillance=false WHERE id=$1`, [mission.id]);
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
    await notify(db, mission.client_id, 'Mission terminée ✅', `"${mission.title}" est terminée. Vous avez 12h pour réclamer si nécessaire.`, 'mission', mission.id, emitToUser, null, 'missionCompletedClientTitle', 'missionCompletedClientBody', {missionTitle: mission.title});
    await notify(db, mission.oeil_id, 'Mission terminée', `"${mission.title}" marquée comme terminée. Paiement en attente de validation.`, 'mission', mission.id, emitToUser, null, 'missionCompletedOeilTitle', 'missionCompletedOeilBody', {missionTitle: mission.title});
  }
  



  const labels = { en_route:'en route', active:'démarrée', cancelled:'annulée', completed:'complétée' };
  const sysMsg = { en_route:"L'Œil est en route.", active:"Mission démarrée.", completed:"Mission terminée avec succès.", cancelled:"Mission annulée." };
  const sysMsgKey = { en_route:'missionEnRoute', active:'missionStarted', completed:'missionCompleted', cancelled:'missionCancelled' };

  await db.query(`INSERT INTO mission_messages (mission_id,sender_id,content,type,content_key) VALUES ($1,$2,$3,'system',$4)`,
    [mission.id, req.user.id, sysMsg[status], sysMsgKey[status]]);

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status });
  io.to('room:admin').emit('mission_updated', updated);

  res.json({ mission: updated });
}));

// ── POST /missions/:id/location ────────────────────────────
router.post('/:id/location', authenticate, requireRole('oeil'), [
  body('lat').isFloat({ min: -90, max: 90 }),
  body('lng').isFloat({ min: -180, max: 180 }),
], asyncHandler(async (req, res) => {
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
}));

// ── POST /missions/:id/report ──────────────────────────────
router.post('/:id/report', authenticate, requireRole('oeil','admin'), [
  body('summary').trim().isLength({ min: 10 }),
  body('score').isInt({ min: 0, max: 100 }),
], asyncHandler(async (req, res) => {
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

  await notify(db, mission.client_id, '📄 Rapport disponible', `Le rapport de "${mission.title}" est prêt.`, 'report', mission.id, emitToUser, null, 'reportAvailableTitle', 'reportAvailableBody', {missionTitle: mission.title});

  res.status(201).json({ report });
}));


// ── POST /:id/messages ─────────────────────────────────
router.post('/:id/messages', authenticate, asyncHandler(async (req, res) => {
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
      `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
       VALUES ($1, $2, $3, 'warning', $4, 'admin_messages_suspects', $5, $6, $7)`,
      [admin.id, '⚠️ Message suspect détecté',
       `${senderName} a peut-être partagé un contact externe dans la mission "${mission.title}"`,
       req.params.id,
       'suspiciousMessageAdminTitle', 'suspiciousMessageAdminBody', JSON.stringify({senderName, missionTitle: mission.title})]
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
      `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
      VALUES ($1, 'Nouveau message', $2, 'message', $3, 'chat', $4, $5, $6)`,
      [recipientId, notifBody, req.params.id, 'newMessageMissionTitle', null, null]
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
}));

router.post('/:id/rate', authenticate, requireRole('client'), [
  body('score').isInt({ min: 1, max: 5 }),
], asyncHandler(async (req, res) => {
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

  const { nps_facilite, nps_reactivite, nps_utilite, nps_recommandation, platform_comment } = req.body;
    await db.query(
      `INSERT INTO ratings (mission_id,client_id,oeil_id,score,comment,
        nps_facilite,nps_reactivite,nps_utilite,nps_recommandation,platform_comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [mission.id, req.user.id, mission.oeil_id, req.body.score, req.body.comment||null,
       nps_facilite||null, nps_reactivite||null, nps_utilite||null, nps_recommandation||null, platform_comment||null]
    );

  const { rows: [avg] } = await db.query('SELECT AVG(score)::numeric(3,1) AS a, COUNT(*)::int AS c FROM ratings WHERE oeil_id=$1', [mission.oeil_id]);
  await db.query('UPDATE oeil_profiles SET rating_avg=$1, rating_count=$2 WHERE user_id=$3', [avg.a, avg.c, mission.oeil_id]);

await notify(db, mission.oeil_id, `Nouvelle note: ${req.body.score}/5 ⭐`, `"${mission.title}" notée par un client.`, 'rating', mission.id, emitToUser, null, 'newRatingTitle', 'newRatingBody', {score: req.body.score, missionTitle: mission.title});

  // Score de fiabilité selon la note
  const score = req.body.score;
  let points, reason;
  if (score >= 4) { points = 10; reason = `Mission complétée, note ${score}/5`; }
  else if (score === 3) { points = 5; reason = `Mission complétée, note 3/5`; }
  else { points = 0; reason = `Mission complétée, note ${score}/5 — insatisfaisant`; }
  await logReliabilityEvent(db, mission.oeil_id, mission.id, points, reason, score <= 2);

  res.status(201).json({ rating_avg: avg.a, rating_count: avg.c });
}));

// ── POST /:id/interest ── Œil exprime son intérêt ─────────

router.post('/:id/interest', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
    const db = getDb();
    const { message } = req.body;
    const { rows: [oeilUser] } = await db.query('SELECT is_suspended, transfer_cooldown_until FROM users WHERE id=$1', [req.user.id]);
    if (oeilUser?.is_suspended) return res.status(403).json({ error: 'Votre compte est suspendu, vous ne pouvez pas postuler à une mission.' });
    if (oeilUser?.transfer_cooldown_until && new Date(oeilUser.transfer_cooldown_until) > new Date()) {
      const remaining = Math.ceil((new Date(oeilUser.transfer_cooldown_until) - Date.now()) / 3600000);
      return res.status(403).json({ error: `Vous ne pouvez pas postuler pendant encore ${remaining}h suite à un transfert de mission.` });
    }
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
  await notify(db, mission.client_id, 'Nouvel Œil intéressé 👁️', notifBody, 'interest', req.params.id, emitToUser, 'interests_modal', 'newOeilInterestTitle', 'newOeilInterestBody', {missionTitle: mission.title});

  res.status(201).json({ ok: true });
}));




// ── POST /missions/:id/transfer ── Œil signale empêchement ──
router.post('/:id/transfer', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');
  const { reason } = req.body;

  if (!reason) return res.status(400).json({ error: 'La raison est obligatoire' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (!['assigned','en_route','active'].includes(mission.status)) {
    return res.status(400).json({ error: 'Transfert impossible pour ce statut' });
  }

  const transferType = mission.status === 'assigned' ? 'before' : 'during';

  // Délai de grâce selon type de mission
  const graceMinutes = mission.type === 'file_attente' ? 45 : 60;
  const deadline = new Date(Date.now() + graceMinutes * 60 * 1000);

  // Cooldown 4h si transfert pendant mission
  if (transferType === 'during') {
    await db.query(
      `UPDATE users SET transfer_cooldown_until=NOW() + INTERVAL '4 hours', transfer_count=transfer_count+1 WHERE id=$1`,
      [req.user.id]
    );
  } else {
    await db.query(
      `UPDATE users SET transfer_count=transfer_count+1 WHERE id=$1`,
      [req.user.id]
    );
  }

  // Remettre la mission en pending avec flag priorité
  await db.query(`
    UPDATE missions SET
      status='pending',
      is_priority=true,
      transfer_type=$1,
      transferred_from=$2,
      transfer_reason=$3,
      transfer_deadline=$4,
      oeil_id=NULL,
      updated_at=NOW()
    WHERE id=$5
  `, [transferType, req.user.id, reason, deadline, mission.id]);

// Pénalité fiabilité — sera recalculée précisément si pas de remplaçant (cron)
  if (transferType === 'before') {
    await logReliabilityEvent(db, req.user.id, mission.id, 5, 'Transfert avant démarrage avec remplaçant', false);
  }


  // Notifications
  await notify(db, mission.client_id,
    '⚠️ Changement sur votre mission',
    `Votre Œil a signalé un empêchement pour "${mission.title}". Nous recherchons un remplaçant en urgence.`,
    'mission', mission.id, emitToUser, null, 'missionChangeAlertTitle', 'missionChangeAlertBody', {missionTitle: mission.title}
  );

  // Message système dans le chat
  await db.query(
    `INSERT INTO mission_messages (mission_id,sender_id,content,type,content_key) VALUES ($1,$2,$3,'system',$4)`,
    [mission.id, req.user.id, `L'Œil a signalé un empêchement. Mission remise en priorité.`, 'missionImpediment']
  );

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status: 'pending' });
  io.to('room:admin').emit('mission_updated', { id: mission.id, is_priority: true });

  res.json({ ok: true, transfer_type: transferType, deadline });
}));

// ── POST /missions/:id/assign-admin ── Admin affecte manuellement ──
router.post('/:id/assign-admin', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');
  const { oeil_id } = req.body;

  if (!oeil_id) return res.status(400).json({ error: 'oeil_id requis' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (!['pending'].includes(mission.status)) return res.status(400).json({ error: 'Mission non disponible pour affectation' });

  // Vérifier que l'Œil est vérifié et disponible
  const { rows: [profile] } = await db.query(
    `SELECT is_verified, is_available FROM oeil_profiles WHERE user_id=$1`, [oeil_id]
  );
  if (!profile?.is_verified) return res.status(400).json({ error: 'Œil non vérifié' });

  const { rows: [oeil] } = await db.query('SELECT first_name, last_name FROM users WHERE id=$1', [oeil_id]);

  await db.query(`
      UPDATE missions SET
        oeil_id=$1,
        status='assigned',
        assigned_at=NOW(),
        is_priority=false,
        transfer_deadline=NULL,
        updated_at=NOW()
      WHERE id=$2
    `, [oeil_id, mission.id]);

  await logStatus(db, mission.id, 'assigned', req.user.id, 'Affectation manuelle par admin');

  await notify(db, oeil_id,
    '📋 Mission assignée par admin',
    `L'admin vous a assigné la mission "${mission.title}". Vérifiez les détails.`,
    'mission', mission.id, emitToUser, null, 'missionAssignedByAdminTitle', 'missionAssignedByAdminBody', {missionTitle: mission.title}
  );
  await notify(db, mission.client_id,
    '✅ Œil trouvé',
    `Un Œil a été assigné à votre mission "${mission.title}".`,
    'mission', mission.id, emitToUser, null, 'oeilFoundClientTitle', 'oeilFoundClientBody', {missionTitle: mission.title}
  );

  await db.query(
    `INSERT INTO mission_messages (mission_id,sender_id,content,type,content_key,params) VALUES ($1,$2,$3,'system',$4,$5)`,
    [mission.id, req.user.id, `${oeil.first_name} a été assigné par l'admin.`, 'assignedByAdmin', JSON.stringify({ oeilName: oeil.first_name })]
  );

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status: 'assigned' });
  io.to('room:admin').emit('mission_updated', { id: mission.id, status: 'assigned' });

  res.json({ ok: true });
}));

// ── Cron : vérifier deadlines transfert expirées ──────────
// (appelé depuis index.js via cron)
async function checkTransferDeadlines(db, emitToUser) {
  const { rows: expired } = await db.query(`
    SELECT * FROM missions
    WHERE status='pending' AND is_priority=true
    AND transfer_deadline IS NOT NULL
    AND transfer_deadline < NOW()
  `);

  for (const mission of expired) {
    // Pénalité aggravée sur l'Œil 1 si pendant mission
if (mission.transfer_type === 'during' && mission.transferred_from) {
        await db.query(`
          UPDATE users SET
            balance=GREATEST(0, balance-100),
            transfer_no_replacement_count=transfer_no_replacement_count+1,
            transfer_cooldown_until=NOW() + INTERVAL '48 hours'
          WHERE id=$1
        `, [mission.transferred_from]);
        await logReliabilityEvent(db, mission.transferred_from, mission.id, -70, 'Transfert pendant mission sans remplaçant trouvé — abandon en cours de mission', true);
        await db.query(
          `INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'debit',100,'Pénalité — aucun remplaçant trouvé',$2)`,
          [mission.transferred_from, mission.id]
        );

      await emitToUser?.(mission.transferred_from, 'notification', {
        title: '⚠️ Pénalité appliquée',
        body: `Aucun remplaçant n'a été trouvé pour "${mission.title}". -100 MAD déduits.`,
        type: 'warning'
      });
      
       } else if (mission.transfer_type === 'before' && mission.transferred_from) {
      await logReliabilityEvent(db, mission.transferred_from, mission.id, -10, 'Transfert avant démarrage sans remplaçant trouvé', true);
   
    }

// Remboursement client — annulation par le système (aucun remplaçant trouvé), non imputable au client : intégral
      await refundOnCancellation(db, mission, false, 'Remboursement — aucun Œil disponible');

      // CRITIQUE : clôturer la mission pour qu'elle sorte définitivement de la boucle du cron.
      // Sans cette étape, la mission reste éligible indéfiniment et la pénalité/remboursement sont rejoués à chaque exécution.
      await db.query(
        `UPDATE missions SET status='cancelled', cancelled_at=NOW(), cancel_reason='Aucun remplaçant trouvé avant expiration du délai', is_priority=false, transfer_deadline=NULL, updated_at=NOW() WHERE id=$1`,
        [mission.id]
      );

    await emitToUser?.(mission.client_id, 'notification', {
      title: '❌ Mission annulée',
      body: `Aucun Œil disponible pour "${mission.title}". Remboursement intégral effectué.`,
      type: 'error'
    });

    await db.query(
      `INSERT INTO notifications (user_id,title,body,type,mission_id,action_type,title_key,body_key,params) VALUES ($1,'❌ Mission annulée','Aucun Œil disponible. Remboursement intégral effectué.','error',$2,'mission_view',$3,$4,$5)`,
      [mission.client_id, mission.id, 'missionCancelledNoReplacementTitle', 'missionCancelledNoReplacementBody', null]
    );
  }
}




// ── POST /:id/hire/:oeilId ── Client choisit un Œil ───────
router.post('/:id/hire/:oeilId', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1 AND client_id=$2',
    [req.params.id, req.user.id]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
if (mission.status !== 'pending') return res.status(400).json({ error: 'Mission non disponible' });
    // Vérifier suspension et cooldown de transfert — sur l'Œil qu'on embauche, pas sur le client
    const { rows: [oeilUser] } = await db.query(
      'SELECT is_suspended, transfer_cooldown_until FROM users WHERE id=$1', [req.params.oeilId]
    );
    if (oeilUser?.is_suspended) {
      return res.status(403).json({ error: 'Cet Œil est actuellement suspendu et ne peut pas être embauché.' });
    }
    if (oeilUser?.transfer_cooldown_until && new Date(oeilUser.transfer_cooldown_until) > new Date()) {
      const remaining = Math.ceil((new Date(oeilUser.transfer_cooldown_until) - Date.now()) / 3600000);
      return res.status(403).json({ error: `Cet Œil ne peut pas être embauché pendant encore ${remaining}h suite à un transfert de mission.` });
    }

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
    `Le client vous a choisi pour : ${mission.title}`, 'hired', req.params.id, emitToUser, null, 'oeilSelectedTitle', 'oeilSelectedBody', {missionTitle: mission.title});

  // Notifier les Œils non retenus
  const { rows: others } = await db.query(
    'SELECT oeil_id FROM mission_interests WHERE mission_id=$1 AND oeil_id!=$2',
    [req.params.id, req.params.oeilId]
  );
  for (const o of others) {
    await notify(db, o.oeil_id, 'Mission pourvue',
      `"${mission.title}" a été attribuée à un autre Œil.`, 'info', req.params.id, emitToUser, null, 'missionFilledTitle', 'missionFilledBody', {missionTitle: mission.title});
  }

  if (io) io.to('room:admin').emit('mission_assigned', updated);

  res.json({ mission: updated });
}));


// ── POST /missions/:id/report-problem ── Signaler un problème ──
router.post('/:id/report-problem', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');
  const { type, description } = req.body;

  if (!type) return res.status(400).json({ error: 'Type de problème requis' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  const canReport = mission.client_id === req.user.id || mission.oeil_id === req.user.id;
  if (!canReport) return res.status(403).json({ error: 'Accès refusé' });

  if (!['assigned','en_route','active'].includes(mission.status)) {
    return res.status(400).json({ error: 'Mission non active' });
  }

  // Vérifier qu'un signalement n'existe pas déjà pour cette mission (contrainte UNIQUE en base)
    const { rows: [existingReport] } = await db.query(
      `SELECT id FROM mission_problem_reports WHERE mission_id=$1`, [mission.id]
    );
    if (existingReport) {
      return res.status(409).json({ error: 'Un problème a déjà été signalé pour cette mission' });
    }
    // Créer le ticket
    const reporterRole = req.user.id === mission.client_id ? 'client' : 'oeil';
    const { rows: [report] } = await db.query(
      `INSERT INTO mission_problem_reports (mission_id, reporter_id, reporter_role, type, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [mission.id, req.user.id, reporterRole, type, description || null]
  );

  // Passer la mission en sous_surveillance
  await db.query(
    `UPDATE missions SET under_surveillance=true, updated_at=NOW() WHERE id=$1`,
    [mission.id]
  );

  // Notifier l'admin
  const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
  for (const admin of admins) {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
       VALUES ($1, '🚨 Problème signalé en cours de mission', $2, 'error', $3, 'admin_problems', $4, $5, $6)`,
      [admin.id, `${reporterRole === 'client' ? 'Client' : 'Œil'} a signalé : "${type}" sur "${mission.title}"`, mission.id,
       'problemReportedAdminTitle', 'problemReportedAdminBody', JSON.stringify({reporterRole: reporterRole === 'client' ? 'Client' : 'Œil', problemType: type, missionTitle: mission.title})]
    );
    if (emitToUser) emitToUser(admin.id, 'notification', {
      title: '🚨 Problème signalé en cours de mission',
      body: `"${type}" sur "${mission.title}"`,
      missionId: mission.id,
      type: 'error'
    });
  }

  // Notifier l'autre partie
  const otherId = req.user.id === mission.client_id ? mission.oeil_id : mission.client_id;
  if (otherId) {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
       VALUES ($1, '⚠️ Problème signalé sur votre mission', $2, 'warning', $3, 'mission_view', $4, $5, $6)`,
      [otherId, `Un problème a été signalé : "${type}". L'équipe Shoofly a été alertée.`, mission.id,
       'problemReportedPartyTitle', 'problemReportedPartyBody', JSON.stringify({problemType: type})]
    );
    if (emitToUser) emitToUser(otherId, 'notification', {
      title: '⚠️ Problème signalé',
      body: `"${type}" — Shoofly a été alerté`,
      missionId: mission.id,
      type: 'warning'
    });
  }

  // Émettre aux deux parties connectées
  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, under_surveillance: true });
  io.to('room:admin').emit('mission_problem_reported', { missionId: mission.id, type, reporterRole });

  res.status(201).json({ report });
}));

// ── GET /missions/admin/problems — admin liste les tickets ──
router.get('/admin/problems', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
      const db = getDb();
      const { status = 'open', page = 1, limit = 20, type, city, reporter_role, sort } = req.query;
      const offset = (page - 1) * limit;

      let where = ['r.status=$1'], params = [status];
      let p = 2;
      if (type) { where.push(`r.type=$${p++}`); params.push(type); }
      if (city) { where.push(`m.city=$${p++}`); params.push(city); }
      if (reporter_role) { where.push(`r.reporter_role=$${p++}`); params.push(reporter_role); }
      const wc = 'WHERE ' + where.join(' AND ');

      const orderBy = sort === 'execution_asc' ? 'm.scheduled_at ASC NULLS LAST'
        : sort === 'execution_desc' ? 'm.scheduled_at DESC NULLS LAST'
        : 'r.created_at ASC'; // Signalement le plus ancien en premier, par défaut

      const { rows } = await db.query(`
          SELECT r.*,
          m.title AS mission_title, m.city, m.scheduled_at, m.id AS mission_ref_id,
          u.first_name AS reporter_first, u.last_name AS reporter_last,
          c.id AS client_id, c.first_name AS client_first, c.last_name AS client_last,
          o.id AS oeil_id, o.first_name AS oeil_first, o.last_name AS oeil_last
          FROM mission_problem_reports r
          JOIN missions m ON m.id = r.mission_id
          JOIN users u ON u.id = r.reporter_id
          LEFT JOIN users c ON c.id = m.client_id
        LEFT JOIN users o ON o.id = m.oeil_id
        ${wc}
        ORDER BY ${orderBy}
        LIMIT $${p++} OFFSET $${p++}
      `, [...params, limit, offset]);

      const { rows: [{ n: total }] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM mission_problem_reports r JOIN missions m ON m.id = r.mission_id ${wc}`, params
      );

      // Villes distinctes disponibles pour peupler le filtre (sur le statut actif, indépendamment des autres filtres)
      const { rows: cities } = await db.query(`
        SELECT DISTINCT m.city FROM mission_problem_reports r JOIN missions m ON m.id = r.mission_id
          WHERE r.status=$1 ORDER BY m.city ASC
      `, [status]);

      res.json({ reports: rows, total, page: +page, pages: Math.ceil(total / limit), availableCities: cities.map(c => c.city) });
  }));

// ── PUT /missions/admin/problems/:id — admin traite un ticket ──
router.put('/admin/problems/:id', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
    const db = getDb();
    const { status, admin_note } = req.body;
    const { rows: [report] } = await db.query(
        `UPDATE mission_problem_reports SET status=$1, admin_note=$2, resolved_by=$3, resolved_at=NOW()
         WHERE id=$4 RETURNING *`,
      [status, admin_note || null, req.user.id, req.params.id]
    );
    if (!report) return res.status(404).json({ error: 'Ticket introuvable' });

    // Notifier le rapporteur (client ou Œil) de la décision admin — persistant, consultable même si la notif est ratée
    const emitToUser = req.app.get('emitToUser');
    const statusLabel = { in_progress: 'pris en charge', resolved: 'résolu', dismissed: 'classé sans suite' }[status] || status;
    const reportStatusTitleKey = { in_progress: 'reportStatusInProgressTitle', resolved: 'reportStatusResolvedTitle', dismissed: 'reportStatusDismissedTitle' }[status] || null;
    const reportBodyKey = admin_note ? null : 'reportStatusDefaultBody';
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
       VALUES ($1, $2, $3, 'info', $4, 'mes_signalements', $5, $6, $7)`,
      [report.reporter_id, `📋 Votre signalement a été ${statusLabel}`, admin_note || 'Votre signalement a été traité par notre équipe.', report.mission_id,
       reportStatusTitleKey, reportBodyKey, null]
    );
    if (emitToUser) emitToUser(report.reporter_id, 'notification', {
      title: `📋 Votre signalement a été ${statusLabel}`,
      body: admin_note || 'Votre signalement a été traité par notre équipe.',
      missionId: report.mission_id
    });

    // Si résolu → retirer sous_surveillance si plus aucun ticket ouvert
    if (['resolved','dismissed'].includes(status)) {
      const { rows: [{ n }] } = await db.query(
          `SELECT COUNT(*)::int AS n FROM mission_problem_reports WHERE mission_id=$1 AND status='open'`,
        [report.mission_id]
      );
      if (n === 0) {
        await db.query(`UPDATE missions SET under_surveillance=false WHERE id=$1`, [report.mission_id]);
      }
    }

  res.json({ report });
}));


router.checkTransferDeadlines = checkTransferDeadlines;
module.exports = router;
