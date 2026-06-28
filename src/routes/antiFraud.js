const router = require('express').Router();
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');

// ══ RÈGLES ANTI-FRAUDE ════════════════════════════════════════
// Score de risque : 0-100. Au-delà de 70 → alerte. Au-delà de 90 → blocage auto.

const RULES = {
  // ── Côté ŒEIL ────────────────────────────────────────────
  OEIL_TOO_FAST_COMPLETE: {
    code: 'OEIL_FAST_COMPLETE',
    label: 'Mission complétée trop rapidement',
    description: 'Mission marquée complétée en moins de 5 minutes après le démarrage',
    score: 40,
    action: 'flag',
  },
  OEIL_NO_MEDIA: {
    code: 'OEIL_NO_MEDIA',
    label: 'Aucun média envoyé',
    description: 'Mission complétée sans aucune photo ou vidéo envoyée',
    score: 35,
    action: 'flag',
  },
  OEIL_LOCATION_MISMATCH: {
    code: 'OEIL_LOCATION_MISMATCH',
    label: 'Géolocalisation incohérente',
    description: 'La position GPS de l\'Œil est à plus de 2 km du lieu de la mission',
    score: 60,
    action: 'flag',
  },
  OEIL_MULTI_CANCEL: {
    code: 'OEIL_MULTI_CANCEL',
    label: 'Annulations répétées',
    description: 'Plus de 3 annulations en 7 jours',
    score: 45,
    action: 'warn',
  },
  OEIL_DUPLICATE_MISSIONS: {
    code: 'OEIL_DUPLICATE_MISSIONS',
    label: 'Missions simultanées suspectes',
    description: 'Deux missions actives en même temps pour le même Œil',
    score: 80,
    action: 'block',
  },
  OEIL_RATING_MANIPULATION: {
    code: 'OEIL_RATING_MANIP',
    label: 'Manipulation de note suspecte',
    description: 'Passage brutal de note basse à note maximale sur plusieurs missions',
    score: 55,
    action: 'flag',
  },
  OEIL_WITHDRAWAL_SPIKE: {
    code: 'OEIL_WITHDRAWAL_SPIKE',
    label: 'Demande de virement anormale',
    description: 'Demande de virement > 3x la moyenne habituelle',
    score: 65,
    action: 'hold',
  },

  // ── Côté CLIENT ──────────────────────────────────────────
  CLIENT_ABUSE_CANCEL: {
    code: 'CLIENT_ABUSE_CANCEL',
    label: 'Annulations abusives',
    description: 'Plus de 3 missions annulées après démarrage en 30 jours',
    score: 50,
    action: 'warn',
  },
  CLIENT_REFUND_ABUSE: {
    code: 'CLIENT_REFUND_ABUSE',
    label: 'Demandes de remboursement répétées',
    description: 'Plus de 2 demandes de remboursement en 14 jours',
    score: 60,
    action: 'flag',
  },
  CLIENT_FAKE_MISSION: {
    code: 'CLIENT_FAKE_MISSION',
    label: 'Mission fictive suspectée',
    description: 'Adresse non vérifiable ou mission acceptée et immédiatement annulée',
    score: 70,
    action: 'flag',
  },
  CLIENT_MULTI_ACCOUNT: {
    code: 'CLIENT_MULTI_ACCOUNT',
    label: 'Compte multiple suspecté',
    description: 'Même IP ou même appareil utilisé pour plusieurs comptes',
    score: 85,
    action: 'block',
  },

  // ── Système ─────────────────────────────────────────────
  PAYMENT_ANOMALY: {
    code: 'PAYMENT_ANOMALY',
    label: 'Anomalie de paiement',
    description: 'Transaction échouée répétée ou montant incohérent',
    score: 75,
    action: 'hold',
  },
  BYPASS_PLATFORM: {
    code: 'BYPASS_PLATFORM',
    label: 'Contournement de plateforme',
    description: 'Échange de coordonnées directes détecté dans les messages',
    score: 90,
    action: 'block',
  },
};

// ── Analyse automatique d'un utilisateur ─────────────────────
async function analyzeUser(db, userId) {
  const alerts = [];
  let totalScore = 0;

  const user = await db.query('SELECT * FROM users WHERE id=$1', [userId]);
  if (!user.rows[0]) return { score: 0, alerts: [], risk: 'low' };
  const u = user.rows[0];

  if (u.role === 'oeil') {
    // Vérifier missions simultanées
    const concurrent = await db.query(
      `SELECT COUNT(*)::int AS n FROM missions WHERE oeil_id=$1 AND status IN ('active','en_route')`, [userId]
    );
    if (concurrent.rows[0].n > 1) {
      alerts.push({ ...RULES.OEIL_DUPLICATE_MISSIONS, detected_at: new Date() });
      totalScore += RULES.OEIL_DUPLICATE_MISSIONS.score;
    }

    // Vérifier annulations répétées (7 jours)
    const cancels = await db.query(
      `SELECT COUNT(*)::int AS n FROM missions WHERE oeil_id=$1 AND status='cancelled' AND cancelled_at > NOW() - INTERVAL '7 days'`, [userId]
    );
    if (cancels.rows[0].n >= 3) {
      alerts.push({ ...RULES.OEIL_MULTI_CANCEL, count: cancels.rows[0].n, detected_at: new Date() });
      totalScore += RULES.OEIL_MULTI_CANCEL.score;
    }

    // Vérifier missions complétées sans médias
    const noMedia = await db.query(
      `SELECT m.id FROM missions m
       LEFT JOIN mission_media mm ON mm.mission_id=m.id
       WHERE m.oeil_id=$1 AND m.status='completed' AND mm.id IS NULL
       AND m.completed_at > NOW() - INTERVAL '30 days'`, [userId]
    );
    if (noMedia.rows.length >= 2) {
      alerts.push({ ...RULES.OEIL_NO_MEDIA, count: noMedia.rows.length, detected_at: new Date() });
      totalScore += RULES.OEIL_NO_MEDIA.score;
    }

    // Vérifier spike de virement
    const avgWithdraw = await db.query(
      `SELECT AVG(amount) AS avg FROM withdrawals WHERE oeil_id=$1 AND status IN ('paid','approved')`, [userId]
    );
    const lastWithdraw = await db.query(
      `SELECT amount FROM withdrawals WHERE oeil_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId]
    );
    if (avgWithdraw.rows[0].avg && lastWithdraw.rows[0]) {
      const ratio = lastWithdraw.rows[0].amount / avgWithdraw.rows[0].avg;
      if (ratio > 3) {
        alerts.push({ ...RULES.OEIL_WITHDRAWAL_SPIKE, ratio: ratio.toFixed(1), detected_at: new Date() });
        totalScore += RULES.OEIL_WITHDRAWAL_SPIKE.score;
      }
    }
  }

  if (u.role === 'client') {
    // Annulations abusives (30 jours)
    const clientCancels = await db.query(
      `SELECT COUNT(*)::int AS n FROM missions WHERE client_id=$1 AND status='cancelled' AND cancelled_at > NOW() - INTERVAL '30 days'`, [userId]
    );
    if (clientCancels.rows[0].n >= 3) {
      alerts.push({ ...RULES.CLIENT_ABUSE_CANCEL, count: clientCancels.rows[0].n, detected_at: new Date() });
      totalScore += RULES.CLIENT_ABUSE_CANCEL.score;
    }
  }

  // Bypass plateforme (scan des messages)
  const suspiciousMessages = await db.query(
    `SELECT COUNT(*)::int AS n FROM mission_messages mm
     JOIN missions m ON m.id=mm.mission_id
     WHERE (m.client_id=$1 OR m.oeil_id=$1)
     AND (mm.content ~* '\\+212|whatsapp|telegram|instagram|06[0-9]{8}|07[0-9]{8}')
     AND mm.created_at > NOW() - INTERVAL '7 days'`, [userId]
  );
  if (suspiciousMessages.rows[0].n > 0) {
    alerts.push({ ...RULES.BYPASS_PLATFORM, count: suspiciousMessages.rows[0].n, detected_at: new Date() });
    totalScore += RULES.BYPASS_PLATFORM.score;
  }

  const capped = Math.min(totalScore, 100);
  const risk = capped >= 80 ? 'critical' : capped >= 50 ? 'high' : capped >= 25 ? 'medium' : 'low';

  return { score: capped, alerts, risk, user_id: userId, role: u.role };
}

// ── GET /anti-fraud/dashboard ─────────────────────────────
router.get('/dashboard', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();

  const [flaggedMissions, suspiciousWithdrawals, recentAlerts, stats] = await Promise.all([
    // Missions suspectes: complétées sans médias récemment
    db.query(`
      SELECT m.id, m.title, m.status, m.price, m.completed_at, m.oeil_id,
        c.first_name||' '||c.last_name AS client_name,
        o.first_name||' '||o.last_name AS oeil_name,
        COUNT(mm.id)::int AS media_count
      FROM missions m
      LEFT JOIN users c ON c.id=m.client_id
      LEFT JOIN users o ON o.id=m.oeil_id
      LEFT JOIN mission_media mm ON mm.mission_id=m.id
      WHERE m.status='completed' AND m.completed_at > NOW() - INTERVAL '7 days'
      GROUP BY m.id, c.first_name, c.last_name, o.first_name, o.last_name
      HAVING COUNT(mm.id) = 0
      LIMIT 10
    `),
    // Virements suspects (> 2x moyenne globale)
    db.query(`
      SELECT w.*, u.first_name||' '||u.last_name AS oeil_name,
        (SELECT AVG(amount) FROM withdrawals WHERE oeil_id=w.oeil_id AND status='paid') AS avg_amount
      FROM withdrawals w JOIN users u ON u.id=w.oeil_id
      WHERE w.status='pending'
      ORDER BY w.amount DESC LIMIT 10
    `),
    // Messages suspects (coordonnées directes)
    db.query(`
      SELECT mm.id, mm.content, mm.created_at, mm.mission_id, mm.sender_id,
        u.first_name||' '||u.last_name AS sender_name
      FROM mission_messages mm JOIN users u ON u.id=mm.sender_id
      WHERE mm.content ~* '\\+212|whatsapp|telegram|06[0-9]{8}|07[0-9]{8}'
      AND mm.created_at > NOW() - INTERVAL '7 days'
      ORDER BY mm.created_at DESC LIMIT 10
    `),
    // Stats globales fraude
    db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM missions WHERE status='cancelled' AND cancelled_at > NOW() - INTERVAL '30 days') AS cancellations_30d,
        (SELECT COUNT(*)::int FROM missions m WHERE m.status='completed' AND m.completed_at > NOW() - INTERVAL '7 days' AND NOT EXISTS (SELECT 1 FROM mission_media mm WHERE mm.mission_id=m.id)) AS no_media_missions,(SELECT COUNT(*)::int FROM withdrawals WHERE status='pending') AS pending_withdrawals,
        (SELECT COUNT(*)::int FROM users WHERE is_active=false) AS blocked_accounts
    `),
  ]);

  res.json({
    flagged_missions: flaggedMissions.rows,
    suspicious_withdrawals: suspiciousWithdrawals.rows,
    suspicious_messages: recentAlerts.rows,
    stats: stats.rows[0],
    rules: Object.values(RULES),
  });
});

// ── POST /anti-fraud/analyze/:userId ─────────────────────
router.post('/analyze/:userId', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const result = await analyzeUser(db, req.params.userId);
  res.json(result);
});

// ── POST /anti-fraud/scan-all ─────────────────────────────
// Scan tous les utilisateurs actifs et retourne les profils à risque
router.post('/scan-all', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const { rows: users } = await db.query(`SELECT id FROM users WHERE is_active=true AND role IN ('client','oeil')`);

  const results = [];
  for (const u of users) {
    const r = await analyzeUser(db, u.id);
    if (r.score > 0) results.push(r);
  }

  results.sort((a, b) => b.score - a.score);
  res.json({ scanned: users.length, flagged: results.filter(r => r.score >= 25).length, results });
});

// ── POST /anti-fraud/warn/:userId ────────────────────────
router.post('/warn/:userId', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const { userId } = req.params;
  const { reason, rule_code, rule_label, mission_id } = req.body;

  if (!userId || userId === 'undefined') {
    return res.status(400).json({ error: 'userId manquant' });
  }

  const { rows: [target] } = await db.query('SELECT id FROM users WHERE id=$1', [userId]);
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });

  // 1. Logger dans la base
  await db.query(
    `INSERT INTO notifications (user_id, title, body, type)
     VALUES ($1, $2, $3, 'warning')`,
[
      userId,
      '⚠️ Activité inhabituelle détectée sur votre compte',
      reason || `Une activité suspecte a été détectée sur votre compte (${rule_label || rule_code}). Merci de vous assurer que vos actions respectent les conditions d'utilisation de Shoofly. En cas de récidive, votre compte pourra être suspendu.`
    ]
  );

  // 2. Envoyer un message dans la messagerie admin → utilisateur
  // Trouver une mission active liée à cet utilisateur pour ouvrir un canal
  const { rows: [mission] } = await db.query(
    mission_id
      ? `SELECT id FROM missions WHERE id=$1`
      : `SELECT id FROM missions WHERE (client_id=$1 OR oeil_id=$1) AND status NOT IN ('cancelled') ORDER BY created_at DESC LIMIT 1`,
    [mission_id || userId]
  );

  if (mission) {
    // Récupérer l'admin
    const { rows: [admin] } = await db.query(
      `SELECT id FROM users WHERE role='admin' LIMIT 1`
    );
    if (admin) {
      await db.query(
        `INSERT INTO mission_messages (mission_id, sender_id, content)
         VALUES ($1, $2, $3)`,
        [
          mission.id,
          admin.id,
          `⚠️ *Message officiel Shoofly*\n\nNous avons détecté une activité inhabituelle sur votre compte : *${rule_label || rule_code}*.\n\n${reason || 'Merci de vous assurer que vos actions sont conformes aux conditions générales d\'utilisation de la plateforme.'}\n\nEn cas de récidive, des mesures supplémentaires pourront être prises, pouvant aller jusqu\'à la suspension de votre compte.\n\n— L\'équipe Shoofly`
        ]
      );
    }
  }

  res.json({ message: 'Avertissement envoyé', user_id: userId });
});

// ── POST /anti-fraud/block/:userId ───────────────────────
router.post('/block/:userId', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const { reason } = req.body;
  await db.query('UPDATE users SET is_active=false WHERE id=$1', [req.params.userId]);
  await db.query(
    `INSERT INTO notifications (user_id,title,body,type) VALUES ($1,'Compte suspendu',$2,'info')`,
    [req.params.userId, reason || 'Votre compte a été suspendu suite à une activité suspecte détectée.']
  );
  res.json({ message: 'Compte bloqué', user_id: req.params.userId });
});

// ── POST /anti-fraud/hold-withdrawal/:id ─────────────────
router.post('/hold-withdrawal/:id', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();
  await db.query(`UPDATE withdrawals SET status='pending', processed_by=NULL WHERE id=$1`, [req.params.id]);
  res.json({ message: 'Virement mis en attente de vérification' });
});

// ── GET /anti-fraud/rules ─────────────────────────────────
router.get('/rules', authenticate, requireRole('admin'), (req, res) => {
  res.json({ rules: Object.values(RULES) });
});

// Export analyzeUser for middleware use
module.exports = router;
module.exports.analyzeUser = analyzeUser;
