const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { refundOnCancellation } = require('../utils/refund');
const { transitionMission, MissionTransitionError } = require('../utils/missionStateMachine');
const walletService = require('../services/walletService');
const { isNewOeil } = require('../utils/reliabilityScore');
const { computeAvgResponseMinutes } = require('../utils/responseTime');
const { getSetting, invalidateSettingsCache } = require('../utils/settings');
const { sendWhatsAppTemplate } = require('../services/wasel');
const waselTemplates = require('../config/waselTemplates');
const asyncHandler = require('../middleware/asyncHandler');
// Réutilise le mécanisme de cascade de réattribution (voir routes/missions.js) plutôt que
// de dupliquer la logique de sélection de candidat pour le cas "Œil désactivé avec mission active".
const missionRoutes = require('./missions');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const identityStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: `shoofly/identity/${req.user?.id}`,
    resource_type: 'image',
    allowed_formats: ['jpg','jpeg','png','webp'],
    transformation: [{ width: 1200, crop: 'limit' }],
  }),
});

const uploadIdentity = multer({
    storage: identityStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        file.originalname = file.originalname.replace(/[&<>"'`%;()]/g, '')
        const allowed = /jpeg|jpg|png|webp/;
        if (allowed.test(file.mimetype)) cb(null, true);
        else cb(new Error('Format non supporté. Utilisez JPG ou PNG.'));
      }
  });

// ── Upload photo de profil (avatar) — Œils et clients ──
const avatarStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: `shoofly/avatars/${req.user?.id}`,
    resource_type: 'image',
    allowed_formats: ['jpg','jpeg','png','webp'],
    transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }],
  }),
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.originalname = file.originalname.replace(/[&<>"'`%;()]/g, '')
    const allowed = /jpeg|jpg|png|webp/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('Format non supporté. Utilisez JPG ou PNG.'));
  }
});

function isWithinSchedule(disponibilites) {
  if (!disponibilites) return true; // pas de créneaux = on se fie au toggle manuel
  const d = typeof disponibilites === 'string' ? JSON.parse(disponibilites) : disponibilites;
  if (!Array.isArray(d) || d.length === 0) return true;
  const now = new Date();
  const map = { 0:'Dim', 1:'Lun', 2:'Mar', 3:'Mer', 4:'Jeu', 5:'Ven', 6:'Sam' };
  const aujourdhui = d.find(x => x.jour === map[now.getDay()]);
  if (!aujourdhui?.actif) return false;
  const [hd, md] = aujourdhui.debut.split(':').map(Number);
  const [hf, mf] = aujourdhui.fin.split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= hd * 60 + md && mins <= hf * 60 + mf;
}



// ── Oeils publics ──────────────────────────────────────────
router.get('/oeils', authenticate, asyncHandler(async (req, res) => {
    const db = getDb();
    const { city, available, search, page = 1, limit = 100 } = req.query;
    const offset = (page - 1) * limit;
    let where = ["u.role='oeil'", "p.is_verified=true"], params = [], p = 1;
    if (city)          { where.push(`u.city ILIKE $${p++}`); params.push(`%${city}%`); }
    if (search) { where.push(`(u.first_name ILIKE $${p} OR u.last_name ILIKE $${p} OR u.city ILIKE $${p})`); params.push(`%${search}%`); p++; }
    if (available==='1') { where.push('p.is_available=true'); }
    const { rows } = await db.query(`
      SELECT u.id,u.first_name,u.last_name,u.city,u.avatar_url,u.disponibilites,
    p.bio,p.coverage_zone,p.is_verified,p.is_available,p.rating_avg,p.rating_count,p.total_missions
  FROM users u JOIN oeil_profiles p ON p.user_id=u.id
      WHERE ${where.join(' AND ')} ORDER BY p.rating_avg DESC, p.total_missions DESC
      LIMIT $${p++} OFFSET $${p++}
    `, [...params, limit, offset]);
    const { rows: [{ n: total }] } = await db.query(`
      SELECT COUNT(*)::int AS n FROM users u JOIN oeil_profiles p ON p.user_id=u.id WHERE ${where.join(' AND ')}
    `, params);
    const newOeilThreshold = await getSetting(db, 'new_oeil_mission_threshold', 10);
    const oeils = rows.map(o => {
      const is_new_oeil = isNewOeil(o.total_missions, newOeilThreshold);
      // Un admin ou l'Œil consultant sa propre fiche voit toujours la vraie note ;
      // seul un tiers (client ou autre Œil) reçoit la valeur masquée.
      const showRealScore = req.user.role === 'admin' || o.id === req.user.id;
      return {
        ...o,
        is_available: o.is_available && isWithinSchedule(o.disponibilites),
        is_new_oeil,
        rating_avg: (!showRealScore && is_new_oeil) ? null : o.rating_avg,
        rating_count: (!showRealScore && is_new_oeil) ? null : o.rating_count,
      };
    })
  res.json({ oeils, total, page: +page, pages: Math.ceil(total / limit) });
  }));

router.get('/oeils/:id', authenticate, asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const db = getDb();
  const { rows: [oeil] } = await db.query(`
    SELECT u.id,u.first_name,u.last_name,u.city,u.avatar_url,u.created_at,u.reliability_score,p.*
    FROM users u JOIN oeil_profiles p ON p.user_id=u.id WHERE u.id=$1 AND u.role='oeil'
  `, [req.params.id]);
  if (!oeil) return res.status(404).json({ error: 'Introuvable' });
  const { rows: reviews } = await db.query(`
    SELECT r.score,r.comment,r.created_at,c.first_name AS client_name
    FROM ratings r JOIN users c ON c.id=r.client_id WHERE r.oeil_id=$1 ORDER BY r.created_at DESC LIMIT 10
  `, [req.params.id]);

  // Consulté par un client (ou un autre Œil) : un débutant (< 10 missions) n'a pas
  // assez d'historique pour qu'un score/note affiché soit significatif — on masque
  // les valeurs brutes plutôt que de compter sur le frontend pour respecter le flag.
  // L'admin et l'Œil consultant sa propre fiche voient toujours le vrai score.
  const showRealScore = req.user.role === 'admin' || oeil.id === req.user.id;
  const newOeilThreshold = await getSetting(db, 'new_oeil_mission_threshold', 10);
  oeil.is_new_oeil = isNewOeil(oeil.total_missions, newOeilThreshold);
  if (!showRealScore && oeil.is_new_oeil) {
    oeil.reliability_score = null;
    oeil.rating_avg = null;
    oeil.rating_count = null;
  }

  // Temps de réponse moyen : métrique indépendante du statut "débutant" —
  // masquée uniquement si l'Œil n'a pas encore assez de tours de conversation.
  oeil.avg_response_minutes = await computeAvgResponseMinutes(db, oeil.id);

  res.json({ oeil, reviews });
}));

// ── Notifications ──────────────────────────────────────────
router.get('/notifications', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND is_read=false`, [req.user.id]);
  res.json({ notifications: rows, unread: n });
}));

router.put('/notifications/read', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { ids } = req.body;
  if (ids?.length) {
    await db.query(`UPDATE notifications SET is_read=true WHERE user_id=$1 AND id=ANY($2)`, [req.user.id, ids]);
  } else {
    await db.query(`UPDATE notifications SET is_read=true WHERE user_id=$1`, [req.user.id]);
  }
  res.json({ message: 'Lu' });
}));

// ── Oeil: disponibilités ───────────────────────────────────
router.get('/oeil/availability', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query('SELECT * FROM oeil_availability WHERE user_id=$1 ORDER BY day_of_week', [req.user.id]);
  res.json({ availability: rows });
}));

router.put('/oeil/availability', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { slots } = req.body;
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots requis' });
  await db.query('DELETE FROM oeil_availability WHERE user_id=$1', [req.user.id]);
  for (const s of slots) {
    await db.query('INSERT INTO oeil_availability (user_id,day_of_week,start_time,end_time,is_active) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, s.day_of_week, s.start_time, s.end_time, s.is_active !== false]);
  }
  res.json({ message: 'Disponibilités mises à jour' });
}));

router.put('/oeil/toggle-available', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: [p] } = await db.query('SELECT is_available FROM oeil_profiles WHERE user_id=$1', [req.user.id]);
  const { rows: [u] } = await db.query('UPDATE oeil_profiles SET is_available=$1 WHERE user_id=$2 RETURNING is_available', [!p.is_available, req.user.id]);
  res.json({ is_available: u.is_available });
}));

// ── Favoris ────────────────────────────────────────────────
router.get('/favorites', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`
    SELECT u.id,u.first_name,u.last_name,u.city,p.rating_avg,p.total_missions,p.is_available
    FROM favorites f JOIN users u ON u.id=f.oeil_id JOIN oeil_profiles p ON p.user_id=u.id
    WHERE f.client_id=$1 ORDER BY f.created_at DESC
  `, [req.user.id]);
  const newOeilThreshold = await getSetting(db, 'new_oeil_mission_threshold', 10);
  const favorites = rows.map(f => {
    const is_new_oeil = isNewOeil(f.total_missions, newOeilThreshold);
    return { ...f, is_new_oeil, rating_avg: is_new_oeil ? null : f.rating_avg };
  });
  res.json({ favorites });
}));

router.post('/favorites/:oeilId', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  await db.query('INSERT INTO favorites (client_id,oeil_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.params.oeilId]);
  res.status(201).json({ message: 'Ajouté aux favoris' });
}));

router.delete('/favorites/:oeilId', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  await db.query('DELETE FROM favorites WHERE client_id=$1 AND oeil_id=$2', [req.user.id, req.params.oeilId]);
  res.json({ message: 'Retiré des favoris' });
}));

// ── Oeil: virement ─────────────────────────────────────────
router.post('/oeil/withdraw', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { amount, bank_info } = req.body;
  if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum 100 MAD' });

  // Transaction + verrou de ligne : évite que deux retraits simultanés passent
  // tous les deux la vérification de solde avant que le premier ne soit committé.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [p] } = await client.query('SELECT balance FROM oeil_profiles WHERE user_id=$1 FOR UPDATE', [req.user.id]);
    if (!p || p.balance < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Solde insuffisant' });
    }
    await client.query('UPDATE oeil_profiles SET balance=balance-$1 WHERE user_id=$2', [amount, req.user.id]);
    await client.query('INSERT INTO withdrawals (oeil_id,amount,bank_info) VALUES ($1,$2,$3)', [req.user.id, amount, JSON.stringify(bank_info)]);
    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, reason) VALUES ($1, 'debit', $2, 'Retrait bancaire')`,
      [req.user.id, amount]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  res.status(201).json({ message: `Virement de ${amount} MAD soumis. Traitement sous 48h.` });
}));

// ══ ADMIN ══════════════════════════════════════════════════
router.get('/admin/all', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { role, is_active } = req.query;
  let where = [], params = [], p = 1;
  if (role)       { where.push(`u.role=$${p++}`); params.push(role); }
  if (is_active !== undefined) { where.push(`u.is_active=$${p++}`); params.push(is_active === '1'); }
  const { rows } = await db.query(`
      SELECT u.id,u.email,u.role,u.first_name,u.last_name,u.phone,u.city,u.avatar_url,u.is_active,u.created_at,
        pr.is_verified,pr.rating_avg,pr.total_missions,pr.balance
      FROM users u LEFT JOIN oeil_profiles pr ON pr.user_id=u.id
      ${where.length ? 'WHERE '+where.join(' AND ') : ''}
      ORDER BY u.created_at DESC
    `, params);
    res.json({ users: rows });
  }));

// ── GET /users/admin/profile/:userId — fiche détaillée consolidée (client ou Œil) ──
router.get('/admin/profile/:userId', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { userId } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  const { rows: [user] } = await db.query(`
    SELECT id, role, first_name, last_name, email, phone, city, quartier, birth_date,
           avatar_url, created_at, is_active, profil, situation, motivation
    FROM users WHERE id=$1
  `, [userId]);

  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (!['client', 'oeil'].includes(user.role)) {
    return res.status(400).json({ error: 'Fiche disponible uniquement pour un client ou un Œil' });
  }

  let oeilProfile = null;
  if (user.role === 'oeil') {
    const { rows: [p] } = await db.query(
      `SELECT rating_avg, rating_count, total_earnings, balance FROM oeil_profiles WHERE user_id=$1`,
      [userId]
    );
    oeilProfile = p || null;
  }

  // ── Onglet Production ──
  const missionsWhere = user.role === 'client' ? 'client_id=$1' : 'oeil_id=$1';
  const missionsSelect = user.role === 'client'
    ? 'id, title, type, status, scheduled_at, created_at, price'
    : 'id, title, type, status, scheduled_at, created_at, oeil_earning';

  const { rows: missions } = await db.query(`
    SELECT ${missionsSelect} FROM missions WHERE ${missionsWhere}
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
  `, [userId, limit, offset]);

  const { rows: [{ n: missionsTotal }] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM missions WHERE ${missionsWhere}`, [userId]
  );

  const production = {
    missions,
    total: missionsTotal,
    page: +page,
    pages: Math.ceil(missionsTotal / limit),
  };

  // ── Onglet Financier ──
  const { rows: walletTransactions } = await db.query(
    `SELECT id, type, amount, reason, mission_id, created_at FROM wallet_transactions WHERE user_id=$1 ORDER BY created_at DESC`,
    [userId]
  );

  let financial;
  if (user.role === 'client') {
    const { rows: [{ total_spent }] } = await db.query(
      `SELECT COALESCE(SUM(price),0)::numeric AS total_spent FROM missions WHERE client_id=$1 AND status='completed'`,
      [userId]
    );
    const { rows: [{ balance }] } = await db.query(`SELECT balance FROM users WHERE id=$1`, [userId]);
    financial = {
      total_spent: parseFloat(total_spent),
      balance: parseFloat(balance),
      wallet_transactions: walletTransactions,
    };
  } else {
    financial = {
      total_earnings: parseFloat(oeilProfile?.total_earnings || 0),
      balance: parseFloat(oeilProfile?.balance || 0),
      wallet_transactions: walletTransactions,
      wire_transfers: walletTransactions.filter(t => t.reason === 'Virement bancaire'),
    };
  }

  // ── Onglet Problèmes remontés ──
    const { rows: reports } = await db.query(`
      SELECT r.id, r.type, r.status, r.created_at, r.mission_id, m.title AS mission_title
      FROM mission_problem_reports r JOIN missions m ON m.id = r.mission_id
      WHERE r.reporter_id=$1
      ORDER BY r.created_at DESC
    `, [userId]);

  const claimsWhere = user.role === 'client' ? 'cl.client_id=$1' : 'm.oeil_id=$1';
  const { rows: claims } = await db.query(`
    SELECT cl.id, cl.status, cl.comment, cl.created_at, cl.resolved_at, cl.mission_id, m.title AS mission_title
    FROM claims cl JOIN missions m ON m.id = cl.mission_id
    WHERE ${claimsWhere}
    ORDER BY cl.created_at DESC
  `, [userId]);

  // ── Onglet Fiabilité (Œil uniquement) ──
  let reliability = null;
  if (user.role === 'oeil') {
    const { rows: [ru] } = await db.query(
      `SELECT reliability_score, is_suspended, suspended_at, suspended_reason FROM users WHERE id=$1`,
      [userId]
    );
    const { rows: events } = await db.query(
      `SELECT id, points, reason, is_grave, created_at, mission_id FROM reliability_events WHERE oeil_id=$1 ORDER BY created_at DESC`,
      [userId]
    );
    reliability = {
      reliability_score: ru.reliability_score,
      is_suspended: ru.is_suspended,
      suspended_at: ru.suspended_at,
      suspended_reason: ru.suspended_reason,
      rating_avg: oeilProfile?.rating_avg || 0,
      rating_count: oeilProfile?.rating_count || 0,
      events,
    };
  }

  res.json({
    user: {
      id: user.id,
      role: user.role,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      phone: user.phone,
      city: user.city,
      quartier: user.quartier,
      birth_date: user.birth_date,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
      is_active: user.is_active,
      profil: user.role === 'client' ? user.profil : undefined,
      situation: user.role === 'oeil' ? user.situation : undefined,
      motivation: user.role === 'oeil' ? user.motivation : undefined,
    },
    production,
    financial,
    problems: { reports, claims },
    reliability,
  });
}));

// ── Client : stats dashboard ────────────────────────────────
router.get('/client/stats', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  const { rows: [stats] } = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status IN ('active','en_route','assigned'))::int AS active,
      COUNT(*) FILTER (WHERE status='completed')::int AS completed,
      COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
      COALESCE(SUM(price) FILTER (WHERE status='completed' AND validated_at IS NOT NULL), 0)::numeric AS total_spent,
      COALESCE(SUM(price) FILTER (WHERE status IN ('pending','assigned','en_route','active')), 0)::numeric AS budget_en_cours,
      COALESCE(SUM(duration_est + 45) FILTER (WHERE status='completed' AND validated_at IS NOT NULL AND duration_est IS NOT NULL), 0)::int AS time_saved_minutes
    FROM missions
    WHERE client_id = $1
  `, [userId]);

  const { rows: [wallet] } = await db.query(
    `SELECT balance FROM users WHERE id=$1`, [userId]
  );

  res.json({ ...stats, wallet_balance: wallet?.balance || 0 });
}));


// ── GET /users/admin/dashboard/executif — KPIs exécutifs avec période + comparaison optionnelle ──
router.get('/admin/dashboard/executif', authenticate, requireRole('admin'), requirePermission('stats'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { date_from, date_to, compare_from, compare_to } = req.query;

  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from et date_to requis' });
  }

  async function computePeriodStats(from, to) {
    const { rows: [m] } = await db.query(`
      SELECT
        COUNT(*)::int AS total_missions,
        COUNT(*) FILTER (WHERE status='completed')::int AS completed_missions,
        COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled_missions,
        COALESCE(SUM(price) FILTER (WHERE status='completed'),0)::numeric AS revenue,
        COALESCE(SUM(commission) FILTER (WHERE status='completed'),0)::numeric AS commission
      FROM missions
      WHERE created_at BETWEEN $1 AND $2
    `, [from, to]);

    const { rows: [nc] } = await db.query(`
      SELECT COUNT(*)::int AS n FROM users WHERE role='client' AND created_at BETWEEN $1 AND $2
    `, [from, to]);

    const { rows: [no] } = await db.query(`
      SELECT COUNT(*)::int AS n FROM users WHERE role='oeil' AND created_at BETWEEN $1 AND $2
    `, [from, to]);

    // Œils/clients actifs = ayant eu au moins une mission sur la période
    const { rows: [activeOeils] } = await db.query(`
      SELECT COUNT(DISTINCT oeil_id)::int AS n FROM missions WHERE oeil_id IS NOT NULL AND created_at BETWEEN $1 AND $2
    `, [from, to]);

    const { rows: [activeClients] } = await db.query(`
      SELECT COUNT(DISTINCT client_id)::int AS n FROM missions WHERE created_at BETWEEN $1 AND $2
    `, [from, to]);

    return {
      ...m,
      new_clients: nc.n,
      new_oeils: no.n,
      active_oeils: activeOeils.n,
      active_clients: activeClients.n,
    };
  }

  // Séries temporelles jour par jour (pour graphique), sur la période principale uniquement
  const { rows: dailySeries } = await db.query(`
    SELECT
      DATE(created_at) AS day,
      COUNT(*)::int AS missions,
      COALESCE(SUM(price) FILTER (WHERE status='completed'),0)::numeric AS revenue
    FROM missions
    WHERE created_at BETWEEN $1 AND $2
    GROUP BY DATE(created_at)
    ORDER BY day ASC
  `, [date_from, date_to]);

  const current = await computePeriodStats(date_from, date_to);
  let comparison = null;
  if (compare_from && compare_to) {
    comparison = await computePeriodStats(compare_from, compare_to);
  }

  res.json({ current, comparison, daily_series: dailySeries });
}));

// ── GET /users/admin/dashboard/alertes — état instantané + comparaison période ──
router.get('/admin/dashboard/alertes', authenticate, requireRole('admin'), requirePermission('stats'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { date_from, date_to, compare_from, compare_to } = req.query;
  const stuckPendingHours = await getSetting(db, 'dashboard_stuck_pending_hours', 24);
  const lowReliabilityThreshold = await getSetting(db, 'dashboard_low_reliability_threshold', 70);

  // ── Section instantanée (indépendante de la période) ──
  const [suspended, surveillance, stuckPending, expiredDeadline, lowReliability, avgScore] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS n FROM users WHERE role='oeil' AND is_suspended=true`),
    db.query(`SELECT COUNT(*)::int AS n FROM missions WHERE under_surveillance=true`),
    db.query(`SELECT COUNT(*)::int AS n FROM missions WHERE status='pending' AND created_at < NOW() - INTERVAL '1 hour' * $1::numeric`, [stuckPendingHours]),
    db.query(`SELECT COUNT(*)::int AS n FROM missions WHERE status='pending' AND transfer_deadline IS NOT NULL AND transfer_deadline < NOW()`),
    db.query(`SELECT COUNT(*)::int AS n FROM users WHERE role='oeil' AND reliability_score < $1::numeric`, [lowReliabilityThreshold]),
    db.query(`SELECT COALESCE(AVG(reliability_score),0)::numeric(5,1) AS avg FROM users WHERE role='oeil'`),
  ]);

  const instant = {
    suspended_oeils: suspended.rows[0].n,
    missions_under_surveillance: surveillance.rows[0].n,
    missions_stuck_pending: stuckPending.rows[0].n,
    missions_expired_deadline: expiredDeadline.rows[0].n,
    low_reliability_oeils: lowReliability.rows[0].n,
    avg_reliability_score: parseFloat(avgScore.rows[0].avg),
  };

  // ── Section période + comparaison ──
  async function computePeriodAlertStats(from, to) {
    if (!from || !to) return null;
    const { rows: [transferFails] } = await db.query(`
      SELECT COUNT(*)::int AS n FROM reliability_events
      WHERE reason ILIKE '%sans remplaçant%' AND created_at BETWEEN $1 AND $2
    `, [from, to]);
    const { rows: [cancelRate] } = await db.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled
      FROM missions WHERE created_at BETWEEN $1 AND $2
    `, [from, to]);
    const { rows: [abandonStats] } = await db.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE transfer_type='before')::int AS abandon_avant,
        COUNT(*) FILTER (WHERE started_at IS NOT NULL)::int AS actives,
        COUNT(*) FILTER (WHERE transfer_type='during')::int AS abandon_pendant
      FROM missions WHERE created_at BETWEEN $1 AND $2
    `, [from, to]);
    return {
      transfer_failures: transferFails.n,
      cancellation_rate: cancelRate.total > 0 ? Math.round((cancelRate.cancelled / cancelRate.total) * 1000) / 10 : 0,
      // Abandon "avant" : mission transférée avant tout début de travail (rapporté au total des missions créées).
      taux_abandon_avant: abandonStats.total > 0 ? Math.round((abandonStats.abandon_avant / abandonStats.total) * 1000) / 10 : 0,
      // Abandon "pendant" : mission transférée en cours de travail (rapporté aux missions ayant atteint le statut 'active').
      taux_abandon_pendant: abandonStats.actives > 0 ? Math.round((abandonStats.abandon_pendant / abandonStats.actives) * 1000) / 10 : 0,
    };
  }

  const current = await computePeriodAlertStats(date_from, date_to);
  const comparison = await computePeriodAlertStats(compare_from, compare_to);

  res.json({ instant, current, comparison });
}));

// ── GET /users/admin/dashboard/services — stats par type de mission ──
router.get('/admin/dashboard/services', authenticate, requireRole('admin'), requirePermission('stats'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { date_from, date_to, compare_from, compare_to } = req.query;

  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from et date_to requis' });
  }

  async function computeServiceStats(from, to) {
    const { rows } = await db.query(`
      SELECT
        m.type,
        COUNT(*)::int AS total_missions,
        COUNT(*) FILTER (WHERE m.status='completed')::int AS completed_missions,
        COALESCE(SUM(m.price) FILTER (WHERE m.status='completed'),0)::numeric AS revenue,
        COALESCE(SUM(m.commission) FILTER (WHERE m.status='completed'),0)::numeric AS commission,
        (SELECT COALESCE(AVG(r.score),0)::numeric(3,1) FROM ratings r
          JOIN missions mm ON mm.id=r.mission_id
          WHERE mm.type=m.type AND mm.created_at BETWEEN $1 AND $2) AS avg_rating,
        COALESCE(AVG(EXTRACT(EPOCH FROM (m.validated_at - m.completed_by_oeil_at))/3600)
          FILTER (WHERE m.status='completed' AND m.validated_at IS NOT NULL AND m.completed_by_oeil_at IS NOT NULL),0)::numeric(6,1) AS delai_moyen_validation
      FROM missions m
      WHERE m.created_at BETWEEN $1 AND $2
      GROUP BY m.type
      ORDER BY total_missions DESC
    `, [from, to]);
    return rows;
  }

  const current = await computeServiceStats(date_from, date_to);
  let comparison = null;
  if (compare_from && compare_to) {
    comparison = await computeServiceStats(compare_from, compare_to);
  }

  res.json({ current, comparison });
}));

// ── GET /users/admin/dashboard/funnel — entonnoir de conversion client ──
router.get('/admin/dashboard/funnel', authenticate, requireRole('admin'), requirePermission('stats'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { date_from, date_to } = req.query;

  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from et date_to requis' });
  }

  // Base : clients inscrits sur la période
  const { rows: [inscrits] } = await db.query(`
    SELECT COUNT(*)::int AS n FROM users WHERE role='client' AND created_at BETWEEN $1 AND $2
  `, [date_from, date_to]);

  // Parmi eux, combien ont créé au moins 1 mission
  const { rows: [aCommande] } = await db.query(`
    SELECT COUNT(DISTINCT u.id)::int AS n
    FROM users u
    JOIN missions m ON m.client_id = u.id
    WHERE u.role='client' AND u.created_at BETWEEN $1 AND $2
  `, [date_from, date_to]);

  // Parmi eux, combien ont eu au moins 1 mission assignée
  const { rows: [assignee] } = await db.query(`
    SELECT COUNT(DISTINCT u.id)::int AS n
    FROM users u
    JOIN missions m ON m.client_id = u.id
    WHERE u.role='client' AND u.created_at BETWEEN $1 AND $2
      AND m.status NOT IN ('pending','cancelled')
  `, [date_from, date_to]);

  // Parmi eux, combien ont eu au moins 1 mission complétée
  const { rows: [completee] } = await db.query(`
    SELECT COUNT(DISTINCT u.id)::int AS n
    FROM users u
    JOIN missions m ON m.client_id = u.id
    WHERE u.role='client' AND u.created_at BETWEEN $1 AND $2
      AND m.status = 'completed'
  `, [date_from, date_to]);

  // Parmi eux, combien ont créé une 2ème mission (réachat)
  const { rows: [revient] } = await db.query(`
    SELECT COUNT(*)::int AS n FROM (
      SELECT u.id
      FROM users u
      JOIN missions m ON m.client_id = u.id
      WHERE u.role='client' AND u.created_at BETWEEN $1 AND $2
      GROUP BY u.id
      HAVING COUNT(m.id) >= 2
    ) sub
  `, [date_from, date_to]);

  const steps = [
    { key: 'inscrits',  label: 'Inscrits',            value: inscrits.n },
    { key: 'commande',  label: 'A créé une mission',  value: aCommande.n },
    { key: 'assignee',  label: 'Mission assignée',    value: assignee.n },
    { key: 'completee', label: 'Mission complétée',   value: completee.n },
    { key: 'revient',   label: 'Client revenu (2e mission)', value: revient.n },
  ];

  // Temps moyen avant la première candidature d'un Œil (missions créées sur la période, ayant reçu au moins 1 candidature)
  const { rows: [premiereCandidature] } = await db.query(`
    SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (fi.first_interest_at - m.created_at))/60),0)::numeric(8,1) AS avg_minutes
    FROM missions m
    JOIN (SELECT mission_id, MIN(created_at) AS first_interest_at FROM mission_interests GROUP BY mission_id) fi
      ON fi.mission_id = m.id
    WHERE m.created_at BETWEEN $1 AND $2
  `, [date_from, date_to]);

  // Temps moyen jusqu'à la sélection d'un Œil (missions créées sur la période, assignées)
  const { rows: [selectionOeil] } = await db.query(`
    SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (assigned_at - created_at))/60),0)::numeric(8,1) AS avg_minutes
    FROM missions
    WHERE assigned_at IS NOT NULL AND created_at BETWEEN $1 AND $2
  `, [date_from, date_to]);

  const kpis = {
    temps_moyen_premiere_candidature: parseFloat(premiereCandidature.avg_minutes),
    temps_moyen_selection_oeil: parseFloat(selectionOeil.avg_minutes),
  };

  res.json({ steps, kpis });
}));

// ── GET /users/admin/dashboard/geo — stats par ville ──
router.get('/admin/dashboard/geo', authenticate, requireRole('admin'), requirePermission('stats'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { date_from, date_to, compare_from, compare_to } = req.query;

  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from et date_to requis' });
  }

  async function computeGeoStats(from, to) {
    const { rows } = await db.query(`
      SELECT
        m.city,
        COUNT(*)::int AS total_missions,
        COUNT(*) FILTER (WHERE m.status='completed')::int AS completed_missions,
        COALESCE(SUM(m.price) FILTER (WHERE m.status='completed'),0)::numeric AS revenue,
        COUNT(DISTINCT m.oeil_id)::int AS active_oeils
      FROM missions m
      WHERE m.created_at BETWEEN $1 AND $2 AND m.city IS NOT NULL
      GROUP BY m.city
      ORDER BY total_missions DESC
    `, [from, to]);
    return rows;
  }

  const current = await computeGeoStats(date_from, date_to);
  let comparison = null;
  if (compare_from && compare_to) {
    comparison = await computeGeoStats(compare_from, compare_to);
  }

  // ── Taux de réutilisation clients, par ville/quartier du CLIENT (pas de la mission) ──
  const { rows: reuseRows } = await db.query(`
    WITH client_zone AS (
      SELECT u.id, u.city, u.quartier, COUNT(m.id)::int AS mission_count
      FROM users u
      JOIN missions m ON m.client_id = u.id AND m.created_at BETWEEN $1 AND $2
      WHERE u.role='client'
      GROUP BY u.id, u.city, u.quartier
    )
    SELECT
      city, quartier,
      COUNT(*)::int AS total_clients,
      COUNT(*) FILTER (WHERE mission_count >= 2)::int AS clients_multi
    FROM client_zone
    WHERE city IS NOT NULL
    GROUP BY city, quartier
  `, [date_from, date_to]);

  // ── Candidatures moyennes par mission, par ville/quartier de la MISSION ──
  const { rows: candidaturesRows } = await db.query(`
    SELECT
      m.city, m.quartier,
      COUNT(*)::int AS total_missions,
      COALESCE(AVG(COALESCE(mi.interest_count,0)),0)::numeric(5,2) AS avg_candidatures
    FROM missions m
    LEFT JOIN (
      SELECT mission_id, COUNT(*)::int AS interest_count FROM mission_interests GROUP BY mission_id
    ) mi ON mi.mission_id = m.id
    WHERE m.created_at BETWEEN $1 AND $2 AND m.city IS NOT NULL
    GROUP BY m.city, m.quartier
  `, [date_from, date_to]);

  // Fusion des deux ventilations (client / mission) en une seule liste par zone (ville+quartier),
  // car les deux métriques ne partagent pas forcément le même dénominateur géographique.
  const zoneKey = (city, quartier) => `${city}::${quartier || ''}`;
  const zonesMap = new Map();
  for (const r of reuseRows) {
    zonesMap.set(zoneKey(r.city, r.quartier), {
      city: r.city,
      quartier: r.quartier,
      taux_reutilisation_clients: r.total_clients > 0 ? Math.round((r.clients_multi / r.total_clients) * 1000) / 10 : 0,
      candidatures_moyennes_par_mission: null,
    });
  }
  for (const r of candidaturesRows) {
    const key = zoneKey(r.city, r.quartier);
    const existing = zonesMap.get(key) || { city: r.city, quartier: r.quartier, taux_reutilisation_clients: null };
    existing.candidatures_moyennes_par_mission = parseFloat(r.avg_candidatures);
    zonesMap.set(key, existing);
  }
  const zones = Array.from(zonesMap.values()).sort((a, b) => a.city.localeCompare(b.city) || (a.quartier || '').localeCompare(b.quartier || ''));

  res.json({ current, comparison, zones });
}));

// ── GET /users/admin/dashboard/oeils — KPIs, classement, alertes Œils ──
router.get('/admin/dashboard/oeils', authenticate, requireRole('admin'), requirePermission('stats'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { date_from, date_to, compare_from, compare_to } = req.query;

  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from et date_to requis' });
  }

  async function computeKpis(from, to) {
    const [totals, interests, avgAssignTime, multiMissions] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_active=true)::int AS actifs,
          COUNT(*) FILTER (WHERE is_active=false)::int AS inactifs
        FROM users WHERE role='oeil'
      `),
      db.query(`
        SELECT
          COUNT(*)::int AS total_interests,
          COUNT(*) FILTER (WHERE m.oeil_id IS NOT NULL AND m.oeil_id = mi.oeil_id)::int AS hired
        FROM mission_interests mi
        JOIN missions m ON m.id = mi.mission_id
        WHERE mi.created_at BETWEEN $1 AND $2
      `, [from, to]),
      db.query(`
        SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (assigned_at - created_at))/3600),0)::numeric(6,1) AS avg_hours
        FROM missions
        WHERE oeil_id IS NOT NULL AND assigned_at IS NOT NULL AND created_at BETWEEN $1 AND $2
      `, [from, to]),
      db.query(`
        SELECT
          COUNT(*)::int AS total_verified,
          COUNT(*) FILTER (WHERE p.total_missions >= 2)::int AS multi
        FROM users u JOIN oeil_profiles p ON p.user_id = u.id
        WHERE u.role='oeil' AND p.is_verified=true
      `),
    ]);

    const acceptanceRate = interests.rows[0].total_interests > 0
      ? Math.round((interests.rows[0].hired / interests.rows[0].total_interests) * 1000) / 10
      : 0;

    const tauxOeilsMultiMissions = multiMissions.rows[0].total_verified > 0
      ? Math.round((multiMissions.rows[0].multi / multiMissions.rows[0].total_verified) * 1000) / 10
      : 0;

    return {
      total_oeils: totals.rows[0].total,
      actifs: totals.rows[0].actifs,
      inactifs: totals.rows[0].inactifs,
      acceptance_rate: acceptanceRate,
      avg_assignment_hours: parseFloat(avgAssignTime.rows[0].avg_hours),
      taux_oeils_multi_missions: tauxOeilsMultiMissions,
    };
  }

  const kpis = await computeKpis(date_from, date_to);
  let kpisCompare = null;
  if (compare_from && compare_to) {
    kpisCompare = await computeKpis(compare_from, compare_to);
  }

  // ── Classement (missions complétées sur la période) ──
  const { rows: ranking } = await db.query(`
    SELECT
      u.id, u.first_name, u.last_name, u.avatar_url,
      COUNT(m.id)::int AS missions_completed,
      COALESCE(SUM(m.oeil_earning),0)::numeric AS revenue,
      p.rating_avg
    FROM users u
    JOIN missions m ON m.oeil_id = u.id AND m.status='completed' AND m.completed_at BETWEEN $1 AND $2
    LEFT JOIN oeil_profiles p ON p.user_id = u.id
    WHERE u.role='oeil'
    GROUP BY u.id, u.first_name, u.last_name, u.avatar_url, p.rating_avg
    ORDER BY missions_completed DESC
    LIMIT 15
  `, [date_from, date_to]);

  // ── Alertes ──
  const [tooManyCancellations, lowRating, frequentDelays] = await Promise.all([
    db.query(`
      SELECT u.id, u.first_name, u.last_name, COUNT(*)::int AS n
      FROM missions m JOIN users u ON u.id = m.oeil_id
      WHERE m.status='cancelled' AND m.oeil_id IS NOT NULL AND m.updated_at BETWEEN $1 AND $2
      GROUP BY u.id, u.first_name, u.last_name
      HAVING COUNT(*) >= 2
      ORDER BY n DESC
    `, [date_from, date_to]),
    db.query(`
      SELECT u.id, u.first_name, u.last_name, p.rating_avg
      FROM users u JOIN oeil_profiles p ON p.user_id = u.id
      WHERE u.role='oeil' AND p.rating_avg > 0 AND p.rating_avg < 3.5
      ORDER BY p.rating_avg ASC
    `),
    db.query(`
      SELECT u.id, u.first_name, u.last_name, COUNT(*)::int AS n
      FROM reliability_events e JOIN users u ON u.id = e.oeil_id
      WHERE e.reason ILIKE '%heure%' AND e.created_at BETWEEN $1 AND $2
      GROUP BY u.id, u.first_name, u.last_name
      HAVING COUNT(*) >= 2
      ORDER BY n DESC
    `, [date_from, date_to]),
  ]);

  // Segmentation par situation et motivation
  const { rows: segByStatus } = await db.query(`
    SELECT COALESCE(situation, 'Non renseigné') AS label, COUNT(*)::int AS n
    FROM users WHERE role='oeil' GROUP BY situation ORDER BY n DESC
  `);
  const { rows: segByMotivation } = await db.query(`
    SELECT COALESCE(motivation, 'Non renseigné') AS label, COUNT(*)::int AS n
    FROM users WHERE role='oeil' GROUP BY motivation ORDER BY n DESC
  `);

  res.json({
    kpis,
    ranking,
    alerts: {
      too_many_cancellations: tooManyCancellations.rows,
      low_rating: lowRating.rows,
      frequent_delays: frequentDelays.rows,
    },
    segmentation: {
      situation: segByStatus,
      motivation: segByMotivation,
    },
  });
}));

// ── GET /users/admin/dashboard/clients — KPIs et top clients ──
router.get('/admin/dashboard/clients', authenticate, requireRole('admin'), requirePermission('stats'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { date_from, date_to, compare_from, compare_to } = req.query;

  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from et date_to requis' });
  }

  async function computeKpis(from, to) {
    const { rows: [stats] } = await db.query(`
      SELECT
        COUNT(DISTINCT m.client_id)::int AS active_clients,
        COUNT(m.id)::int AS total_missions,
        COALESCE(AVG(m.price),0)::numeric(10,2) AS avg_basket,
        COUNT(*) FILTER (WHERE m.status='cancelled' AND m.status != 'pending')::int AS cancelled_before_assign
      FROM missions m
      WHERE m.created_at BETWEEN $1 AND $2
    `, [from, to]);

    const { rows: [freq] } = await db.query(`
      SELECT COALESCE(AVG(cnt),0)::numeric(4,1) AS avg_missions_per_client FROM (
        SELECT client_id, COUNT(*)::int AS cnt FROM missions
        WHERE created_at BETWEEN $1 AND $2
        GROUP BY client_id
      ) sub
    `, [from, to]);

    return {
      active_clients: stats.active_clients,
      total_missions: stats.total_missions,
      avg_basket: parseFloat(stats.avg_basket),
      avg_missions_per_client: parseFloat(freq.avg_missions_per_client),
    };
  }

  const kpis = await computeKpis(date_from, date_to);
  let kpisCompare = null;
  if (compare_from && compare_to) {
    kpisCompare = await computeKpis(compare_from, compare_to);
  }

  const { rows: topClients } = await db.query(`
    SELECT
      u.id, u.first_name, u.last_name, u.city,
      COUNT(m.id)::int AS total_missions,
      COALESCE(SUM(m.price),0)::numeric AS total_spent
    FROM users u
    JOIN missions m ON m.client_id = u.id
    WHERE u.role='client' AND m.created_at BETWEEN $1 AND $2
    GROUP BY u.id, u.first_name, u.last_name, u.city
    ORDER BY total_spent DESC
    LIMIT 15
  `, [date_from, date_to]);

  // Segmentation par profil client
  const { rows: segmentation } = await db.query(`
    SELECT
      COALESCE(u.profil, 'Non renseigné') AS profil,
      COUNT(DISTINCT u.id)::int AS clients,
      COUNT(m.id)::int AS total_missions,
      COALESCE(SUM(m.price),0)::numeric AS revenue
    FROM users u
    JOIN missions m ON m.client_id = u.id
    WHERE u.role='client' AND m.created_at BETWEEN $1 AND $2
    GROUP BY u.profil
    ORDER BY clients DESC
  `, [date_from, date_to]);

  res.json({ kpis, kpisCompare, topClients, segmentation });
}));

// ── GET /users/admin/dashboard/fileattente — stats file d'attente ──
router.get('/admin/dashboard/fileattente', authenticate, requireRole('admin'), requirePermission('stats'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { date_from, date_to, compare_from, compare_to } = req.query;

  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from et date_to requis' });
  }

  async function computeKpis(from, to) {
    const { rows: [stats] } = await db.query(`
      SELECT
        COUNT(*)::int AS total_missions,
        COUNT(*) FILTER (WHERE status='completed')::int AS completed_missions,
        COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at))/60) FILTER (WHERE status='completed' AND started_at IS NOT NULL),0)::numeric(6,1) AS avg_wait_minutes,
        COALESCE(SUM(
          EXTRACT(EPOCH FROM (completed_at - started_at))/3600 + 1
        ) FILTER (WHERE status='completed' AND started_at IS NOT NULL),0)::numeric(10,1) AS hours_saved
      FROM missions
      WHERE type='file_attente' AND created_at BETWEEN $1 AND $2
    `, [from, to]);
    return {
      total_missions: stats.total_missions,
      completed_missions: stats.completed_missions,
      avg_wait_minutes: parseFloat(stats.avg_wait_minutes),
      hours_saved: parseFloat(stats.hours_saved),
    };
  }

  const kpis = await computeKpis(date_from, date_to);
  let kpisCompare = null;
  if (compare_from && compare_to) {
    kpisCompare = await computeKpis(compare_from, compare_to);
  }

  // Organismes les plus demandés — extrait la partie après le "—" de subcategory
  const { rows: rawOrgs } = await db.query(`
    SELECT subcategory, COUNT(*)::int AS n
    FROM missions
    WHERE type='file_attente' AND created_at BETWEEN $1 AND $2 AND subcategory IS NOT NULL
    GROUP BY subcategory
  `, [date_from, date_to]);

  const orgCounts = {};
  for (const row of rawOrgs) {
    const parts = row.subcategory.split('—').map(s => s.trim());
    const org = parts.length > 1 ? parts[1] : row.subcategory;
    orgCounts[org] = (orgCounts[org] || 0) + row.n;
  }
  const topOrganismes = Object.entries(orgCounts)
    .map(([organisme, missions]) => ({ organisme, missions }))
    .sort((a, b) => b.missions - a.missions)
    .slice(0, 10);

  res.json({ kpis, kpisCompare, topOrganismes });
}));

// ── POST /users/admin/expenses — ajouter une dépense manuelle ──
router.post('/admin/expenses', authenticate, requireRole('admin'), requirePermission('finance'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { amount, category, description, expense_date } = req.body;

  if (!amount || amount <= 0 || !category || !expense_date) {
    return res.status(400).json({ error: 'Montant, catégorie et date requis' });
  }

  const { rows: [expense] } = await db.query(
    `INSERT INTO expenses (amount, category, description, expense_date, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [amount, category, description || null, expense_date, req.user.id]
  );

  res.status(201).json({ expense });
}));

// ── GET /users/admin/expenses — lister les dépenses sur une période ──
router.get('/admin/expenses', authenticate, requireRole('admin'), requirePermission('finance'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { date_from, date_to } = req.query;

  const { rows } = await db.query(`
    SELECT e.*, u.first_name, u.last_name
    FROM expenses e
    LEFT JOIN users u ON u.id = e.created_by
    WHERE e.expense_date BETWEEN $1 AND $2
    ORDER BY e.expense_date DESC
  `, [date_from, date_to]);

  res.json({ expenses: rows });
}));

// ── DELETE /users/admin/expenses/:id — supprimer une dépense ──
router.delete('/admin/expenses/:id', authenticate, requireRole('admin'), requirePermission('finance'), asyncHandler(async (req, res) => {
  const db = getDb();
  await db.query(`DELETE FROM expenses WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// ── GET /users/admin/dashboard/financier — vue financière globale ──
// ── GET /users/admin/dashboard/campagnes — performance par campagne d'acquisition ──
router.get('/admin/dashboard/campagnes', authenticate, requireRole('admin'), requirePermission('stats'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { date_from, date_to } = req.query;

  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from et date_to requis' });
  }

  const { rows } = await db.query(`
    SELECT
      COALESCE(u.acquisition_source, 'Direct / inconnu') AS source,
      COALESCE(u.acquisition_medium, '—') AS medium,
      COALESCE(u.acquisition_campaign, '—') AS campaign,
      COUNT(DISTINCT u.id)::int AS inscriptions,
      COUNT(m.id)::int AS missions,
      COALESCE(SUM(m.price),0)::numeric AS revenue
    FROM users u
    LEFT JOIN missions m ON m.client_id = u.id
    WHERE u.role='client' AND u.created_at BETWEEN $1 AND $2
    GROUP BY u.acquisition_source, u.acquisition_medium, u.acquisition_campaign
    ORDER BY inscriptions DESC
  `, [date_from, date_to]);

  res.json({ campaigns: rows });
}));

router.get('/admin/dashboard/financier', authenticate, requireRole('admin'), requirePermission('stats'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { date_from, date_to, compare_from, compare_to } = req.query;

  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from et date_to requis' });
  }

  async function computeFinance(from, to) {
    const { rows: [main] } = await db.query(`
      SELECT
        COALESCE(SUM(price) FILTER (WHERE status='completed'),0)::numeric AS revenue,
        COALESCE(SUM(commission) FILTER (WHERE status='completed'),0)::numeric AS commission,
        COALESCE(SUM(oeil_earning) FILTER (WHERE status='completed'),0)::numeric AS paid_to_oeils
      FROM missions
      WHERE created_at BETWEEN $1 AND $2
    `, [from, to]);

    const { rows: [refunds] } = await db.query(`
      SELECT COALESCE(SUM(amount),0)::numeric AS n
      FROM wallet_transactions
      WHERE type='credit' AND reason ILIKE '%emboursement%' AND created_at BETWEEN $1 AND $2
    `, [from, to]);

    const { rows: [fileAttenteRate] } = await db.query(`
      SELECT
        COALESCE(SUM(oeil_earning),0)::numeric AS total_earning,
        COALESCE(SUM(EXTRACT(EPOCH FROM (completed_at - started_at))/3600) FILTER (WHERE started_at IS NOT NULL),0)::numeric AS total_hours
      FROM missions
      WHERE type='file_attente' AND status='completed' AND created_at BETWEEN $1 AND $2
    `, [from, to]);

    const hourlyRate = fileAttenteRate.total_hours > 0
      ? parseFloat(fileAttenteRate.total_earning) / parseFloat(fileAttenteRate.total_hours)
      : 0;

    const { rows: [hoursSaved] } = await db.query(`
      SELECT COALESCE(SUM(
        EXTRACT(EPOCH FROM (completed_at - started_at))/3600 + 1
      ) FILTER (WHERE started_at IS NOT NULL),0)::numeric AS n
      FROM missions
      WHERE type='file_attente' AND status='completed' AND created_at BETWEEN $1 AND $2
    `, [from, to]);

    const timeSavedValue = parseFloat(hoursSaved.n) * hourlyRate;

    return {
      revenue: parseFloat(main.revenue),
      commission: parseFloat(main.commission),
      paid_to_oeils: parseFloat(main.paid_to_oeils),
      refunds: parseFloat(refunds.n),
      hourly_rate_file_attente: Math.round(hourlyRate * 100) / 100,
      time_saved_value: Math.round(timeSavedValue),
    };
  }

  const current = await computeFinance(date_from, date_to);
  let comparison = null;
  if (compare_from && compare_to) {
    comparison = await computeFinance(compare_from, compare_to);
  }

  const { rows: [expensesRow] } = await db.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS n FROM expenses WHERE expense_date BETWEEN $1 AND $2`,
    [date_from, date_to]
  );
  current.expenses = parseFloat(expensesRow.n);
  current.net_profit = current.commission - current.expenses;

  if (comparison) {
    const { rows: [expensesCompareRow] } = await db.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS n FROM expenses WHERE expense_date BETWEEN $1 AND $2`,
      [compare_from, compare_to]
    );
    comparison.expenses = parseFloat(expensesCompareRow.n);
    comparison.net_profit = comparison.commission - comparison.expenses;
  }

  res.json({ current, comparison });
}));

// ── GET /users/admin/dashboard/experience-utilisateur — NPS (4 dimensions) + tickets de support ──
router.get('/admin/dashboard/experience-utilisateur', authenticate, requireRole('admin'), requirePermission('stats'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { date_from, date_to, compare_from, compare_to } = req.query;

  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from et date_to requis' });
  }

  async function computeNps(from, to) {
    const { rows: [nps] } = await db.query(`
      SELECT
        COALESCE(AVG(nps_facilite),0)::numeric(3,2) AS avg_facilite,
        COALESCE(AVG(nps_reactivite),0)::numeric(3,2) AS avg_reactivite,
        COALESCE(AVG(nps_utilite),0)::numeric(3,2) AS avg_utilite,
        COALESCE(AVG(nps_recommandation),0)::numeric(3,2) AS avg_recommandation,
        COUNT(*) FILTER (
          WHERE nps_facilite IS NOT NULL OR nps_reactivite IS NOT NULL
             OR nps_utilite IS NOT NULL OR nps_recommandation IS NOT NULL
        )::int AS nb_evaluations
      FROM ratings
      WHERE created_at BETWEEN $1 AND $2
    `, [from, to]);
    return {
      avg_facilite: parseFloat(nps.avg_facilite),
      avg_reactivite: parseFloat(nps.avg_reactivite),
      avg_utilite: parseFloat(nps.avg_utilite),
      avg_recommandation: parseFloat(nps.avg_recommandation),
      nb_evaluations: nps.nb_evaluations,
    };
  }

  async function computeTicketStats(from, to) {
    const { rows: [resolution] } = await db.query(`
      SELECT
        COALESCE(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE status='resolved'),0)::numeric(6,1) AS avg_resolution_hours,
        COUNT(*) FILTER (WHERE status='resolved')::int AS total_resolved,
        COUNT(*) FILTER (WHERE status='resolved' AND resolved_by IS NULL)::int AS auto_resolved
      FROM support_tickets
      WHERE created_at BETWEEN $1 AND $2
    `, [from, to]);

    const { rows: byCategory } = await db.query(`
      SELECT category, COUNT(*)::int AS n
      FROM support_tickets
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY category
      ORDER BY n DESC
    `, [from, to]);

    return {
      temps_moyen_resolution: parseFloat(resolution.avg_resolution_hours),
      taux_auto_resolution: resolution.total_resolved > 0
        ? Math.round((resolution.auto_resolved / resolution.total_resolved) * 1000) / 10
        : 0,
      total_resolved: resolution.total_resolved,
      par_categorie: byCategory,
    };
  }

  const nps = await computeNps(date_from, date_to);
  const npsComparison = (compare_from && compare_to) ? await computeNps(compare_from, compare_to) : null;

  const tickets = await computeTicketStats(date_from, date_to);
  const ticketsComparison = (compare_from && compare_to) ? await computeTicketStats(compare_from, compare_to) : null;

  // Instantané, indépendant de la période : tickets encore ouverts/en cours actuellement
  const { rows: [openSnapshot] } = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='open')::int AS open,
      COUNT(*) FILTER (WHERE status='in_progress')::int AS in_progress
    FROM support_tickets
  `);

  res.json({
    nps: { current: nps, comparison: npsComparison },
    tickets: { current: tickets, comparison: ticketsComparison },
    tickets_ouverts_actuellement: {
      open: openSnapshot.open,
      in_progress: openSnapshot.in_progress,
    },
  });
}));

router.get('/admin/stats', authenticate, requireRole('admin'), requirePermission('stats'), asyncHandler(async (req, res) => {
  const db = getDb();
  const [u, m, rev, wd, byType, byStatus, topOeils] = await Promise.all([
    db.query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE role='client')::int AS clients,
      COUNT(*) FILTER (WHERE role='oeil')::int AS oeils
      FROM users`),
    db.query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status IN ('active','en_route','assigned'))::int AS active,
      COUNT(*) FILTER (WHERE status='completed')::int AS completed,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending,
      COALESCE(SUM(commission) FILTER (WHERE status='completed'),0)::numeric AS revenue,
      COALESCE(SUM(price) FILTER (WHERE status='completed'),0)::numeric AS volume
      FROM missions`),
    db.query(`SELECT COUNT(*)::int AS n FROM oeil_profiles WHERE is_verified=true`),
    db.query(`SELECT COUNT(*)::int AS n FROM withdrawals WHERE status='pending'`),
    db.query(`SELECT type, COUNT(*)::int AS count FROM missions GROUP BY type`),
    db.query(`SELECT status, COUNT(*)::int AS count FROM missions GROUP BY status`),
    db.query(`SELECT u.first_name||' '||u.last_name AS name, p.total_missions, p.rating_avg, p.total_earnings
              FROM oeil_profiles p JOIN users u ON u.id=p.user_id ORDER BY p.total_missions DESC LIMIT 5`),
  ]);
  res.json({
    ...u.rows[0], ...m.rows[0],
    verified_oeils: rev.rows[0].n,
    pending_withdrawals: wd.rows[0].n,
    missions_by_type: byType.rows,
    missions_by_status: byStatus.rows,
    top_oeils: topOeils.rows,
  });
}));

router.put('/admin/:id/verify-oeil', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  await db.query(`UPDATE oeil_profiles SET is_verified=true, id_verified_at=NOW() WHERE user_id=$1`, [req.params.id]);
  const notif = await db.query(`INSERT INTO notifications (user_id,title,body,type,action_type,title_key,body_key,params) VALUES ($1,'✅ Profil vérifié !','Vous pouvez maintenant accepter des missions.','info','none',$2,$3,$4) RETURNING *`, [req.params.id, 'profileVerifiedTitle', 'profileVerifiedBody', null]);
  if (emitToUser) emitToUser(req.params.id, 'notification', notif.rows[0]);
  res.json({ message: 'Œil vérifié' });
}));

router.put('/admin/:id/toggle-active', authenticate, requireRole('admin'), requirePermission('users'), asyncHandler(async (req, res) => {
    const db = getDb();
    const emitToUser = req.app.get('emitToUser');
    const io = req.app.get('io');
    const { rows: [target] } = await db.query('SELECT role FROM users WHERE id=$1', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'Introuvable' });
    if (target.role === 'admin' && !req.user.is_super_admin) {
      return res.status(403).json({ error: 'Seul le Super Admin peut activer/désactiver un compte administrateur.' });
    }
    const { rows: [u] } = await db.query(`UPDATE users SET is_active = NOT is_active WHERE id=$1 RETURNING is_active`, [req.params.id]);

    // Désactivation (pas réactivation) d'un Œil ayant une mission active/en_route/assignée :
    // réattribution automatique via la cascade de confirmation séquentielle, sans jamais
    // resolliciter le client. transfer_type est toujours forcé à 'before' (jamais 'during'),
    // même si la mission était déjà 'active'/'en_route' : contrairement à un abandon volontaire
    // en cours de mission (qui donne lieu à un split au prorata via mission_transfer_chain),
    // une désactivation admin ne doit produire AUCUN mouvement financier ni pénalité pour l'Œil
    // désactivé — le remplaçant touche l'intégralité de oeil_earning.
    let reassignedCount = 0;
    if (!u.is_active && target.role === 'oeil') {
      const { rows: strandedMissions } = await db.query(
        `SELECT * FROM missions WHERE oeil_id=$1 AND status IN ('assigned','en_route','active')`,
        [req.params.id]
      );
      const graceMinutesQueue = await getSetting(db, 'transfer_grace_minutes_queue', 45);
      const graceMinutesOther = await getSetting(db, 'transfer_grace_minutes_other', 60);
      for (const mission of strandedMissions) {
        const graceMinutes = mission.type === 'file_attente' ? graceMinutesQueue : graceMinutesOther;
        const deadline = new Date(Date.now() + graceMinutes * 60 * 1000);
        let updated;
        try {
          updated = await transitionMission(db, mission.id, mission.status, 'pending', req.user.id, {
            extraFields: {
              is_priority: true,
              transfer_type: 'before',
              transferred_from: req.params.id,
              transfer_reason: 'Compte prestataire désactivé par un administrateur',
              transfer_deadline: deadline,
              oeil_id: null,
            },
            note: 'Réattribution automatique — Œil désactivé par un admin',
          });
        } catch (e) {
          if (e instanceof MissionTransitionError) continue; // statut déjà changé entre-temps
          throw e;
        }
        reassignedCount++;

        // Retire la propre candidature de l'Œil désactivé sur sa propre mission (même correctif
        // que POST /:id/transfer, voir bug fantôme audit 2.9) avant de lancer la cascade.
        await db.query(`DELETE FROM mission_interests WHERE mission_id=$1 AND oeil_id=$2`, [updated.id, req.params.id]);

        await missionRoutes.advanceCandidateCascade(db, io, emitToUser, updated, {});

        const reassignTitle = '📋 Mission réattribuée';
        const reassignBody = `Votre mission "${mission.title}" a été réattribuée à un autre Œil suite à la désactivation de votre compte. Aucune pénalité ni retenue financière ne vous est appliquée pour cette mission.`;
        await missionRoutes.notify(db, req.params.id, reassignTitle, reassignBody,
          'mission', mission.id, emitToUser, null, 'missionReassignedNoPenaltyTitle', 'missionReassignedNoPenaltyBody', { missionTitle: mission.title });

        const { rows: [oeilContact] } = await db.query('SELECT phone FROM users WHERE id=$1', [req.params.id]);
        if (oeilContact?.phone) {
          await sendWhatsAppTemplate(waselTemplates.oeil_reassigned_no_penalty.template_name, oeilContact.phone, [mission.title]);
        }
      }
    }

    res.json({ is_active: u.is_active, reassigned_missions: reassignedCount });
  }));

// ── Admin : paramètres ─────────────────────────────────────
router.get('/admin/settings', authenticate, requireRole('admin'), requirePermission('finance'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query('SELECT * FROM settings');
  const settings = {}
  rows.forEach(r => settings[r.key] = r.value)
  res.json({ settings })
}))

router.put('/admin/settings', authenticate, requireRole('admin'), requirePermission('finance'), asyncHandler(async (req, res) => {
  const db = getDb();
const {
  commission, min_price, five_star_bonus_active, five_star_bonus_percent,
  transfer_grace_minutes_queue, transfer_grace_minutes_other,
  candidate_window_minutes_fast, candidate_window_minutes_choose_queue, candidate_window_minutes_choose_other,
  mission_edit_approval_minutes, mission_edit_approval_minutes_urgent, mission_edit_urgent_threshold_hours,
  client_validation_hours, schedule_conflict_window_hours, transfer_cooldown_hours,
  abandon_during_mission_cooldown_hours, stale_mission_hours, stale_mission_min_lead_hours,
  mission_overdue_verification_hours, late_start_alert_window_minutes, late_start_auto_transfer_minutes,
  reminder_before_mission_minutes_early, reminder_before_mission_minutes_late,
  refund_partial_threshold_hours, refund_partial_rate,
  new_oeil_mission_threshold, reactivation_default_score, ticket_auto_resolve_hours,
  response_time_max_valid_minutes, response_time_min_turns,
  dashboard_stuck_pending_hours, dashboard_low_reliability_threshold,
  candidate_confirmation_minutes,
  presence_confirmation_deadline_minutes, presence_confirmation_deadline_minutes_sameday,
  candidate_batch_size, candidate_tiebreak_window_minutes,
} = req.body
  const updates = {
    commission, min_price, five_star_bonus_active, five_star_bonus_percent,
    transfer_grace_minutes_queue, transfer_grace_minutes_other,
    candidate_window_minutes_fast, candidate_window_minutes_choose_queue, candidate_window_minutes_choose_other,
    mission_edit_approval_minutes, mission_edit_approval_minutes_urgent, mission_edit_urgent_threshold_hours,
    client_validation_hours, schedule_conflict_window_hours, transfer_cooldown_hours,
    abandon_during_mission_cooldown_hours, stale_mission_hours, stale_mission_min_lead_hours,
    mission_overdue_verification_hours, late_start_alert_window_minutes, late_start_auto_transfer_minutes,
    reminder_before_mission_minutes_early, reminder_before_mission_minutes_late,
    refund_partial_threshold_hours, refund_partial_rate,
    new_oeil_mission_threshold, reactivation_default_score, ticket_auto_resolve_hours,
    response_time_max_valid_minutes, response_time_min_turns,
    dashboard_stuck_pending_hours, dashboard_low_reliability_threshold,
    candidate_confirmation_minutes,
    presence_confirmation_deadline_minutes, presence_confirmation_deadline_minutes_sameday,
    candidate_batch_size, candidate_tiebreak_window_minutes,
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      await db.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2`,
        [key, String(value)]
      )
    }
  }
  invalidateSettingsCache()
  res.json({ ok: true })
}))

// ── Admin : messages suspects ───────────────────────────────
router.get('/admin/flagged-messages', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`
    SELECT mm.id, mm.content, mm.created_at, mm.mission_id,
      u.first_name||' '||u.last_name AS sender_name, u.role AS sender_role,
      m.title AS mission_title
    FROM mission_messages mm
    JOIN users u ON u.id = mm.sender_id
    JOIN missions m ON m.id = mm.mission_id
    WHERE mm.is_flagged = true
    ORDER BY mm.created_at DESC
    LIMIT 50
  `);
  res.json({ messages: rows });
}));

// ── Admin : réclamations ────────────────────────────────────
router.get('/admin/claims', authenticate, requireRole('admin'), requirePermission('claims'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`
    SELECT cl.*,
      m.title AS mission_title, m.price AS mission_price, m.oeil_earning, m.oeil_id,
      c.first_name||' '||c.last_name AS client_name,
      o.first_name||' '||o.last_name AS oeil_name
    FROM claims cl
    JOIN missions m ON m.id = cl.mission_id
    JOIN users c ON c.id = cl.client_id
    JOIN users o ON o.id = m.oeil_id
    WHERE cl.status = 'pending'
    ORDER BY cl.created_at ASC
  `);
  res.json({ claims: rows });
}));

// ── Admin : résoudre une réclamation ───────────────────────
router.put('/admin/claims/:missionId/resolve', authenticate, requireRole('admin'), requirePermission('finance'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { decision } = req.body;
  if (!['oeil','client'].includes(decision)) return res.status(400).json({ error: 'Décision invalide' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.missionId]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.status !== 'sous_reclamation') return res.status(409).json({ error: 'Cette réclamation a déjà été traitée' });

  // Écritures DB interdépendantes (statut, solde, ledger, claims) dans une seule
  // transaction — la garde optimiste de transitionMission (WHERE status=$X) protège
  // contre deux admins résolvant la même réclamation simultanément (la 2e requête
  // reçoit STALE_STATE -> 409, aucune double écriture possible).
  let refund;
  try {
    await walletService.withTransaction(db, async (client) => {
      if (decision === 'oeil') {
        await walletService.credit(client, mission.oeil_id, 'oeil', mission.oeil_earning, 'Mission validée après réclamation', mission.id);
        await transitionMission(client, mission.id, 'sous_reclamation', 'completed', req.user.id, {
          extraFields: { validated_at: 'NOW()', is_priority: false },
          note: 'Réclamation résolue en faveur de l\'Œil',
        });
        await client.query(`UPDATE claims SET status='resolved_oeil', resolved_by=$1, resolved_at=NOW() WHERE mission_id=$2`, [req.user.id, mission.id]);
      } else {
        // Réclamation gagnée par le client, non imputable à lui : remboursement intégral
        refund = await refundOnCancellation(client, mission, false, 'Remboursement suite à réclamation');
        await transitionMission(client, mission.id, 'sous_reclamation', 'cancelled', req.user.id, {
          extraFields: { is_priority: false },
          note: 'Réclamation résolue en faveur du client',
        });
        await client.query(`UPDATE claims SET status='resolved_client', resolved_by=$1, resolved_at=NOW() WHERE mission_id=$2`, [req.user.id, mission.id]);
        // Fermer automatiquement tout signalement encore ouvert lié à cette mission —
        // la mission étant annulée, le problème signalé est désormais sans objet.
        await client.query(
          `UPDATE mission_problem_reports SET status='resolved', admin_note=COALESCE(admin_note, 'Résolu automatiquement suite à l''annulation de la mission'), resolved_by=$1, resolved_at=NOW()
             WHERE mission_id=$2 AND status IN ('open','in_progress')`,
          [req.user.id, mission.id]
        );
        await client.query(`UPDATE missions SET under_surveillance=false WHERE id=$1`, [mission.id]);
      }
    });
  } catch (e) {
    if (e instanceof MissionTransitionError) return res.status(409).json({ error: e.message });
    throw e;
  }

  // Notifications APRÈS le commit — jamais dans la transaction (règle de périmètre :
  // pas d'appel réseau/lent pendant qu'une connexion DB est retenue).
  const emitToUser = req.app.get('emitToUser');
  const notify = async (userId, title, body, titleKey = null, bodyKey = null, params = null) => {
    await db.query(
      `INSERT INTO notifications (user_id,title,body,type,mission_id,action_type,title_key,body_key,params) VALUES ($1,$2,$3,'info',$4,'mission_view',$5,$6,$7)`,
      [userId, title, body, mission.id, titleKey, bodyKey, params ? JSON.stringify(params) : null]
    );
    if (emitToUser) emitToUser(userId, 'notification', { title, body });
  }

  if (decision === 'oeil') {
    await notify(mission.oeil_id, '✅ Réclamation résolue', 'Résolue en votre faveur. Paiement crédité.', 'claimResolvedOeilWinTitle', 'claimResolvedOeilWinBody', null);
    await notify(mission.client_id, 'Réclamation résolue', 'Résolue en faveur de l\'Œil.', 'claimResolvedClientLoseTitle', 'claimResolvedClientLoseBody', null);
  } else {
    await notify(mission.client_id, '✅ Réclamation résolue', `${refund} MAD crédités sur votre portefeuille.`, 'claimResolvedOeilWinTitle', 'claimResolvedClientWinBody', { amount: refund });
    await notify(mission.oeil_id, 'Réclamation résolue', 'Résolue en faveur du client.', 'claimResolvedClientLoseTitle', 'claimResolvedOeilLoseBody', null);
  }

  res.json({ ok: true });
}));


router.get('/admin/withdrawals', authenticate, requireRole('admin'), requirePermission('finance'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`
    SELECT w.*, u.first_name||' '||u.last_name AS oeil_name, u.phone AS oeil_phone
    FROM withdrawals w JOIN users u ON u.id=w.oeil_id ORDER BY w.created_at DESC
  `);
  res.json({ withdrawals: rows });
}));

router.put('/admin/withdrawals/:id', authenticate, requireRole('admin'), requirePermission('finance'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const { status } = req.body;
  if (!['approved','paid','rejected'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  const { rows: [w] } = await db.query('SELECT * FROM withdrawals WHERE id=$1', [req.params.id]);
  if (!w) return res.status(404).json({ error: 'Introuvable' });
  await db.query(`UPDATE withdrawals SET status=$1,processed_by=$2,processed_at=NOW() WHERE id=$3`, [status, req.user.id, req.params.id]);
  if (status === 'rejected') {
    await db.query('UPDATE oeil_profiles SET balance=balance+$1 WHERE user_id=$2', [w.amount, w.oeil_id]);
    const n = await db.query(`INSERT INTO notifications (user_id,title,body,type,action_type,title_key,body_key,params) VALUES ($1,'Virement refusé','Votre demande a été refusée. Solde recrédité.','info','gains_page',$2,$3,$4) RETURNING *`, [w.oeil_id, 'withdrawalRejectedTitle', 'withdrawalRejectedBody', null]);
    if (emitToUser) emitToUser(w.oeil_id, 'notification', n.rows[0]);
  }
  if (status === 'paid') {
    const n = await db.query(`INSERT INTO notifications (user_id,title,body,type,action_type,title_key,body_key,params) VALUES ($1,'💸 Virement effectué',$2,'info','gains_page',$3,$4,$5) RETURNING *`, [w.oeil_id, `${w.amount} MAD virés sur votre compte.`, 'withdrawalPaidTitle', 'withdrawalPaidBody', JSON.stringify({ amount: w.amount })]);
    if (emitToUser) emitToUser(w.oeil_id, 'notification', n.rows[0]);
  }
  res.json({ message: `Virement ${status}` });
}));


// ── POST /users/oeil/identity — upload documents identité ──
router.post('/oeil/identity', authenticate, requireRole('oeil'), uploadIdentity.fields([
  { name: 'cin_recto', maxCount: 1 },
  { name: 'cin_verso', maxCount: 1 },
  { name: 'selfie',    maxCount: 1 },
]), asyncHandler(async (req, res) => {
  const db = getDb();
  const cin_recto = req.files?.cin_recto?.[0]?.path;
  const cin_verso = req.files?.cin_verso?.[0]?.path;
  const selfie    = req.files?.selfie?.[0]?.path;

  if (!cin_recto || !cin_verso || !selfie) {
    return res.status(400).json({ error: 'Les 3 documents sont requis (CIN recto, verso, selfie)' });
  }

  // Supprimer l'ancienne demande si rejetée
  await db.query(
    `DELETE FROM identity_documents WHERE user_id=$1 AND status='rejected'`,
    [req.user.id]
  );

  // Vérifier qu'il n'y a pas déjà une demande en attente ou approuvée
  const { rows: [existing] } = await db.query(
    `SELECT id, status FROM identity_documents WHERE user_id=$1 AND status IN ('pending','approved')`,
    [req.user.id]
  );
  if (existing) {
    return res.status(400).json({ error: existing.status === 'approved' ? 'Identité déjà vérifiée' : 'Demande déjà en attente de vérification' });
  }

  const { rows: [doc] } = await db.query(
    `INSERT INTO identity_documents (user_id, cin_recto, cin_verso, selfie)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.user.id, cin_recto, cin_verso, selfie]
  );

  res.json({ message: 'Documents soumis avec succès', document: doc });
}));

// ── GET /users/admin/identity-requests — liste demandes en attente ──
router.get('/admin/identity-requests', authenticate, requireRole('admin'), requirePermission('identity'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { status = 'pending' } = req.query;

  const { rows } = await db.query(`
      SELECT d.*, u.first_name, u.last_name, u.email, u.phone, u.city, u.avatar_url
      FROM identity_documents d
      JOIN users u ON u.id=d.user_id
      WHERE d.status=$1
      ORDER BY d.created_at ASC
    `, [status]);
    res.json({ requests: rows });
  }));

// ── POST /users/admin/identity-requests/:id/approve ──
router.post('/admin/identity-requests/:id/approve', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();

  const { rows: [doc] } = await db.query(
    `UPDATE identity_documents SET status='approved', reviewed_by=$1, reviewed_at=NOW()
     WHERE id=$2 RETURNING *`,
    [req.user.id, req.params.id]
  );
  if (!doc) return res.status(404).json({ error: 'Demande introuvable' });

  // Marquer l'Œil comme vérifié
  await db.query(
    `UPDATE oeil_profiles SET is_verified=true WHERE user_id=$1`,
    [doc.user_id]
  );
  await db.query(
    `UPDATE users SET updated_at=NOW() WHERE id=$1`,
    [doc.user_id]
  );

 // Notification in-app
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
       VALUES ($1, '✅ Identité vérifiée', 'Félicitations ! Votre identité a été vérifiée avec succès. Vous pouvez maintenant accepter des missions sur Shoofly.', 'success', 'none', $2, $3, $4)`,
      [doc.user_id, 'identityVerifiedTitle', 'identityVerifiedBody', null]
    );
    // Test technique API Wasel — même bouton, aucune étape supplémentaire pour l'admin.
    // Réutilise nouvelle_verification_identite (contenu sans rapport avec l'approbation,
    // assumé pour ce test de plomberie, en attendant un vrai template "approuvé" chez Wasel).
    const { rows: [oeilContact] } = await db.query('SELECT phone, first_name, last_name FROM users WHERE id=$1', [doc.user_id]);
    if (oeilContact?.phone) {
      const oeilName = `${oeilContact.first_name} ${oeilContact.last_name}`.trim();
      sendWhatsAppTemplate('nouvelle_verification_identite', oeilContact.phone, [oeilName]);
    } else {
      console.warn(`[wasel] Œil ${doc.user_id} sans téléphone renseigné — envoi ignoré (identity approved)`);
    }

  res.json({ message: 'Identité approuvée', user_id: doc.user_id });
}));

// ── POST /users/admin/identity-requests/:id/reject ──
router.post('/admin/identity-requests/:id/reject', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { reason } = req.body;

  const { rows: [doc] } = await db.query(
    `UPDATE identity_documents SET status='rejected', rejected_reason=$1, reviewed_by=$2, reviewed_at=NOW()
     WHERE id=$3 RETURNING *`,
    [reason || 'Documents non conformes', req.user.id, req.params.id]
  );
  if (!doc) return res.status(404).json({ error: 'Demande introuvable' });

  // Mettre à jour le profil avec la raison du rejet
  await db.query(
    `UPDATE oeil_profiles SET is_verified=false, rejection_reason=$1 WHERE user_id=$2`,
    [reason || 'Documents non conformes', doc.user_id]
  );

  // Notification in-app
  await db.query(
    `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
     VALUES ($1, '❌ Vérification refusée', $2, 'error', 'verification_page', $3, $4, $5)`,
    [doc.user_id, `Votre demande de vérification a été refusée. Raison : ${reason || 'Documents non conformes'}. Vous pouvez soumettre de nouveaux documents.`, 'identityRejectedTitle', 'identityRejectedBody', JSON.stringify({ reason: reason || 'Documents non conformes' })]
  );

  res.json({ message: 'Identité rejetée', user_id: doc.user_id });
}));

// ── GET /users/oeil/earnings — l'Œil consulte son historique de gains ──
// ── POST /users/avatar — upload/changement de photo de profil (Œil et client) ──
router.post('/avatar', authenticate, uploadAvatar.single('avatar'), asyncHandler(async (req, res) => {
  const db = getDb();
  const avatarUrl = req.file?.path;
  if (!avatarUrl) {
    return res.status(400).json({ error: 'Aucune image reçue' });
  }

  const { rows: [updated] } = await db.query(
    `UPDATE users SET avatar_url=$1, updated_at=NOW() WHERE id=$2 RETURNING id, avatar_url`,
    [avatarUrl, req.user.id]
  );

  res.json({ ok: true, avatar_url: updated.avatar_url });
}));

router.get('/oeil/earnings', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();

  // Missions terminées avec gain réel
  const { rows: missions } = await db.query(`
    SELECT
      id, title, type, oeil_earning AS amount, status, scheduled_at,
      completed_at AS event_date
    FROM missions
    WHERE oeil_id=$1 AND status='completed'
    ORDER BY completed_at DESC
  `, [req.user.id]);

  // Virements enregistrés (wallet_transactions, reason = virement)
  const { rows: transfers } = await db.query(`
    SELECT id, amount, reason, created_at AS event_date
    FROM wallet_transactions
    WHERE user_id=$1 AND reason='Virement bancaire'
    ORDER BY created_at DESC
  `, [req.user.id]);

  // Fusionner les deux sources, triées chronologiquement (plus récent en premier)
  const lines = [
    ...missions.map(m => ({
      kind: 'mission',
      id: m.id,
      title: m.title,
      type: m.type,
      scheduled_at: m.scheduled_at,
      status: m.status,
      amount: parseFloat(m.amount),
      event_date: m.event_date,
    })),
    ...transfers.map(t => ({
      kind: 'transfer',
      id: t.id,
      title: 'Virement bancaire',
      amount: -parseFloat(t.amount), // sortie d'argent, affichée en négatif dans l'historique
      event_date: t.event_date,
    })),
  ].sort((a, b) => new Date(b.event_date) - new Date(a.event_date));

  const { rows: [profile] } = await db.query(
    `SELECT balance, total_earnings FROM oeil_profiles WHERE user_id=$1`, [req.user.id]
  );

  res.json({ lines, balance: profile?.balance || 0, total_earnings: profile?.total_earnings || 0 });
}));

// ── GET /users/admin/finance/oeils — admin liste les Œils avec solde pour paiement ──
router.get('/admin/finance/oeils', authenticate, requireRole('admin'), requirePermission('finance'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`
    SELECT u.id, u.first_name, u.last_name, u.email, u.city,
           p.balance, p.total_earnings, p.total_missions
    FROM users u
    JOIN oeil_profiles p ON p.user_id = u.id
    WHERE u.role='oeil'
    ORDER BY p.balance DESC
  `);
  res.json({ oeils: rows });
}));

// ── POST /users/admin/finance/:oeilId/wire-transfer — admin enregistre un virement ──
router.post('/admin/finance/:oeilId/wire-transfer', authenticate, requireRole('admin'), requirePermission('finance'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { amount } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Montant invalide' });
  }

  // Même défaut que l'ancien bug withdraw (commit f6e7376) : lecture du solde puis
  // update séparés, sans verrou — deux virements admin simultanés sur le même Œil
  // pouvaient tous deux passer la vérification avant que le premier ne soit committé.
  // walletService.debit() fait SELECT ... FOR UPDATE + vérification + update + ledger
  // dans une seule transaction.
  let transaction;
  try {
    await walletService.withTransaction(db, async (client) => {
      const { rows: [profile] } = await client.query(
        `SELECT 1 FROM oeil_profiles WHERE user_id=$1`, [req.params.oeilId]
      );
      if (!profile) { const err = new Error('Œil introuvable'); err.code = 'NOT_FOUND'; throw err; }

      await walletService.debit(client, req.params.oeilId, 'oeil', amount, 'Virement bancaire');
      const { rows: [row] } = await client.query(
        `SELECT * FROM wallet_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [req.params.oeilId]
      );
      transaction = row;
    });
  } catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
    if (e.code === 'INSUFFICIENT_BALANCE') return res.status(400).json({ error: 'Solde insuffisant pour ce montant' });
    throw e;
  }

  // Notification APRÈS le commit (règle de périmètre des transactions).
  await db.query(
    `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
     VALUES ($1, '💰 Virement effectué', $2, 'success', 'gains_page', $3, $4, $5)`,
    [req.params.oeilId, `Un virement de ${amount} MAD a été enregistré vers votre compte bancaire.`, 'withdrawalRegisteredTitle', 'withdrawalRegisteredBody', JSON.stringify({ amount })]
  );

  res.json({ ok: true, transaction });
}));

// Admin joins its own WS room on connect (done client-side)
module.exports = router;