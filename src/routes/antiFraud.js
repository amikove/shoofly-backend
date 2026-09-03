const router = require('express').Router();
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { getSetting } = require('../utils/settings');
const asyncHandler = require('../middleware/asyncHandler');
const { transitionMission, MissionTransitionError } = require('../utils/missionStateMachine');
const { sendWhatsAppTemplate } = require('../services/wasel');
const waselTemplates = require('../config/waselTemplates');
// Réutilise le mécanisme de cascade de réattribution (voir routes/missions.js) plutôt que
// de dupliquer la logique de sélection de candidat — même approche que
// PUT /users/admin/:id/toggle-active (routes/users.js).
const missionRoutes = require('./missions');

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

    // Vérifier annulations répétées (fenêtre configurable, défaut 7 jours — setting anti-fraude)
    const oeilCancelLookbackDays = await getSetting(db, 'fraud_oeil_cancel_lookback_days', 7);
    const cancels = await db.query(
      `SELECT COUNT(*)::int AS n FROM missions WHERE oeil_id=$1 AND status='cancelled' AND cancelled_at > NOW() - INTERVAL '1 day' * $2::numeric`,
      [userId, oeilCancelLookbackDays]
    );
    if (cancels.rows[0].n >= 3) {
      alerts.push({ ...RULES.OEIL_MULTI_CANCEL, count: cancels.rows[0].n, detected_at: new Date() });
      totalScore += RULES.OEIL_MULTI_CANCEL.score;
    }

    // Vérifier missions complétées sans médias (fenêtre configurable, défaut 30 jours)
    const oeilNoMediaLookbackDays = await getSetting(db, 'fraud_oeil_nomedia_lookback_days', 30);
    const noMedia = await db.query(
      `SELECT m.id FROM missions m
       LEFT JOIN mission_media mm ON mm.mission_id=m.id
       WHERE m.oeil_id=$1 AND m.status='completed' AND mm.id IS NULL
       AND m.completed_at > NOW() - INTERVAL '1 day' * $2::numeric`,
      [userId, oeilNoMediaLookbackDays]
    );
    if (noMedia.rows.length >= 2) {
      alerts.push({ ...RULES.OEIL_NO_MEDIA, count: noMedia.rows.length, detected_at: new Date() });
      totalScore += RULES.OEIL_NO_MEDIA.score;
    }
// Vérifier missions complétées trop rapidement (fenêtre + seuil configurables, défauts 30 j / 300 s)
    const oeilTooFastLookbackDays = await getSetting(db, 'fraud_oeil_too_fast_lookback_days', 30);
    const oeilTooFastSeconds = await getSetting(db, 'fraud_oeil_too_fast_seconds', 300);
    const tooFast = await db.query(
      `SELECT COUNT(*)::int AS n FROM missions
       WHERE oeil_id=$1 AND status='completed'
       AND completed_at > NOW() - INTERVAL '1 day' * $2::numeric
       AND EXTRACT(EPOCH FROM (completed_at - started_at)) < $3::numeric`,
      [userId, oeilTooFastLookbackDays, oeilTooFastSeconds]
    );
    if (tooFast.rows[0].n >= 2) {
      alerts.push({ ...RULES.OEIL_TOO_FAST_COMPLETE, count: tooFast.rows[0].n, detected_at: new Date() });
      totalScore += RULES.OEIL_TOO_FAST_COMPLETE.score;
    }

    // Vérifier manipulation de note (fenêtre avant/après configurable, défaut 48 h). UNE seule
    // clé volontairement : les 2 requêtes doivent pivoter sur le même instant (5★ DANS la
    // fenêtre récente vs moyenne AVANT cette même fenêtre) — 2 clés créeraient un trou/chevauchement.
    const ratingSpikeWindowHours = await getSetting(db, 'fraud_rating_spike_window_hours', 48);
    const ratingSpike = await db.query(
      `SELECT COUNT(*)::int AS n FROM ratings
       WHERE oeil_id=$1 AND score=5
       AND created_at > NOW() - INTERVAL '1 hour' * $2::numeric`,
      [userId, ratingSpikeWindowHours]
    );
    const avgBefore = await db.query(
      `SELECT AVG(score) AS avg FROM ratings
       WHERE oeil_id=$1
       AND created_at < NOW() - INTERVAL '1 hour' * $2::numeric`,
      [userId, ratingSpikeWindowHours]
    );
    if (ratingSpike.rows[0].n >= 3 && avgBefore.rows[0].avg && parseFloat(avgBefore.rows[0].avg) < 3) {
      alerts.push({ ...RULES.OEIL_RATING_MANIPULATION, spike: ratingSpike.rows[0].n, avg_before: parseFloat(avgBefore.rows[0].avg).toFixed(1), detected_at: new Date() });
      totalScore += RULES.OEIL_RATING_MANIPULATION.score;
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
    // Annulations abusives (fenêtre configurable, défaut 30 jours)
    const clientCancelLookbackDays = await getSetting(db, 'fraud_client_cancel_lookback_days', 30);
    const clientCancels = await db.query(
      `SELECT COUNT(*)::int AS n FROM missions WHERE client_id=$1 AND status='cancelled' AND cancelled_at > NOW() - INTERVAL '1 day' * $2::numeric`,
      [userId, clientCancelLookbackDays]
    );
    if (clientCancels.rows[0].n >= 3) {
      alerts.push({ ...RULES.CLIENT_ABUSE_CANCEL, count: clientCancels.rows[0].n, detected_at: new Date() });
      totalScore += RULES.CLIENT_ABUSE_CANCEL.score;
    }

    // Demandes de remboursement répétées (fenêtre configurable, défaut 14 jours)
    const clientRefundLookbackDays = await getSetting(db, 'fraud_client_refund_lookback_days', 14);
    const refunds = await db.query(
      `SELECT COUNT(*)::int AS n FROM claims
       WHERE client_id=$1
       AND created_at > NOW() - INTERVAL '1 day' * $2::numeric`,
      [userId, clientRefundLookbackDays]
    );
    if (refunds.rows[0].n >= 2) {
      alerts.push({ ...RULES.CLIENT_REFUND_ABUSE, count: refunds.rows[0].n, detected_at: new Date() });
      totalScore += RULES.CLIENT_REFUND_ABUSE.score;
    }

    // Mission fictive — acceptée et annulée immédiatement (fenêtre + seuil configurables, défauts 30 j / 600 s)
    const clientFakeMissionLookbackDays = await getSetting(db, 'fraud_client_fake_mission_lookback_days', 30);
    const clientFakeMissionSeconds = await getSetting(db, 'fraud_client_fake_mission_seconds', 600);
    const fakeMissions = await db.query(
      `SELECT COUNT(*)::int AS n FROM missions
       WHERE client_id=$1 AND status='cancelled'
       AND cancelled_at > NOW() - INTERVAL '1 day' * $2::numeric
       AND EXTRACT(EPOCH FROM (cancelled_at - created_at)) < $3::numeric`,
      [userId, clientFakeMissionLookbackDays, clientFakeMissionSeconds]
    );
    if (fakeMissions.rows[0].n >= 2) {
      alerts.push({ ...RULES.CLIENT_FAKE_MISSION, count: fakeMissions.rows[0].n, detected_at: new Date() });
      totalScore += RULES.CLIENT_FAKE_MISSION.score;
    }
  }

// Anomalie de paiement — à activer après intégration CMI
  // const paymentFails = await db.query(
  //   `SELECT COUNT(*)::int AS n FROM payments
  //    WHERE user_id=$1 AND status='failed'
  //    AND created_at > NOW() - INTERVAL '7 days'`,
  //   [userId]
  // );
  // if (paymentFails.rows[0]?.n >= 3) {
  //   alerts.push({ ...RULES.PAYMENT_ANOMALY, count: paymentFails.rows[0].n, detected_at: new Date() });
  //   totalScore += RULES.PAYMENT_ANOMALY.score;
  // }

  // Bypass plateforme (scan des messages — fenêtre configurable, défaut 7 jours)
  const messageScanLookbackDays = await getSetting(db, 'fraud_message_scan_lookback_days', 7);
  const suspiciousMessages = await db.query(
    `SELECT COUNT(*)::int AS n FROM mission_messages mm
     JOIN missions m ON m.id=mm.mission_id
     WHERE (m.client_id=$1 OR m.oeil_id=$1)
     AND (mm.content ~* '\\+212|whatsapp|telegram|instagram|06[0-9]{8}|07[0-9]{8}')
     AND mm.created_at > NOW() - INTERVAL '1 day' * $2::numeric`,
    [userId, messageScanLookbackDays]
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
router.get('/dashboard', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();

  // Fenêtres d'AFFICHAGE de cet écran (settings anti-fraude) — distinctes des fenêtres de
  // scoring d'analyzeUser : élargir un rapport ne doit pas changer le comportement de blocage.
  // recentDays pilote les 2 listes récentes + le compteur no_media_missions ; cancellationsDays
  // ne pilote que le compteur cancellations_30d.
  const dashboardRecentDays = await getSetting(db, 'fraud_dashboard_recent_days', 7);
  const dashboardCancellationsDays = await getSetting(db, 'fraud_dashboard_cancellations_days', 30);

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
      WHERE m.status='completed' AND m.completed_at > NOW() - INTERVAL '1 day' * $1::numeric
      GROUP BY m.id, c.first_name, c.last_name, o.first_name, o.last_name
      HAVING COUNT(mm.id) = 0
      LIMIT 10
    `, [dashboardRecentDays]),
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
      AND mm.created_at > NOW() - INTERVAL '1 day' * $1::numeric
      ORDER BY mm.created_at DESC LIMIT 10
    `, [dashboardRecentDays]),
    // Stats globales fraude
    db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM missions WHERE status='cancelled' AND cancelled_at > NOW() - INTERVAL '1 day' * $1::numeric) AS cancellations_30d,
        (SELECT COUNT(*)::int FROM missions m WHERE m.status='completed' AND m.completed_at > NOW() - INTERVAL '1 day' * $2::numeric AND NOT EXISTS (SELECT 1 FROM mission_media mm WHERE mm.mission_id=m.id)) AS no_media_missions,(SELECT COUNT(*)::int FROM withdrawals WHERE status='pending') AS pending_withdrawals,
        (SELECT COUNT(*)::int FROM users WHERE is_active=false) AS blocked_accounts
    `, [dashboardCancellationsDays, dashboardRecentDays]),
  ]);

  res.json({
    flagged_missions: flaggedMissions.rows,
    suspicious_withdrawals: suspiciousWithdrawals.rows,
    suspicious_messages: recentAlerts.rows,
    stats: stats.rows[0],
    rules: Object.values(RULES),
  });
}));

// ── POST /anti-fraud/analyze/:userId ─────────────────────
router.post('/analyze/:userId', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const result = await analyzeUser(db, req.params.userId);
  res.json(result);
}));

// ── POST /anti-fraud/scan-all ─────────────────────────────
// Scan tous les utilisateurs actifs et retourne les profils à risque
router.post('/scan-all', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: users } = await db.query(`SELECT id FROM users WHERE is_active=true AND role IN ('client','oeil')`);

  const results = [];
  for (const u of users) {
    const r = await analyzeUser(db, u.id);
    if (r.score > 0) results.push(r);
  }

  results.sort((a, b) => b.score - a.score);
  res.json({ scanned: users.length, flagged: results.filter(r => r.score >= 25).length, results });
}));

// ── POST /anti-fraud/warn/:userId ────────────────────────
router.post('/warn/:userId', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
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
    `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
     VALUES ($1, $2, $3, 'warning', 'none', $4, $5, $6)`,
[
      userId,
      '⚠️ Activité inhabituelle détectée sur votre compte',
      reason || `Une activité suspecte a été détectée sur votre compte (${rule_label || rule_code}). Merci de vous assurer que vos actions respectent les conditions d'utilisation de Shoofly. En cas de récidive, votre compte pourra être suspendu.`,
      'suspiciousActivityTitle',
      reason ? null : 'suspiciousActivityDefaultBody',
      reason ? null : JSON.stringify({ ruleLabel: rule_label || rule_code })
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
}));

// ── POST /anti-fraud/block/:userId ───────────────────────
router.post('/block/:userId', authenticate, requireRole('admin'), requirePermission('moderation'), asyncHandler(async (req, res) => {
    const db = getDb();
    const emitToUser = req.app.get('emitToUser');
    const io = req.app.get('io');
    const { reason } = req.body;
    const { rows: [target] } = await db.query('SELECT role, phone FROM users WHERE id=$1', [req.params.userId]);
    if (!target) return res.status(404).json({ error: 'Introuvable' });
    if (target.role === 'admin' && !req.user.is_super_admin) {
      return res.status(403).json({ error: 'Seul le Super Admin peut bloquer un compte administrateur.' });
    }
    await db.query(`UPDATE users SET is_active=false WHERE id=$1`, [req.params.userId]);
  const suspensionReason = reason || 'Votre compte a été suspendu suite à une activité suspecte détectée.';
  await db.query(
    `INSERT INTO notifications (user_id,title,body,type,action_type,title_key,body_key,params) VALUES ($1,'Compte suspendu',$2,'info','none',$3,$4,$5)`,
    [req.params.userId, suspensionReason, 'accountSuspendedTitle', reason ? null : 'accountSuspendedDefaultBody', null]
  );
  // Cas particulier (voir waselTemplates.js) : seul canal encore capable d'atteindre cet
  // utilisateur puisqu'il ne peut plus se connecter à l'app (is_active=false). Ne s'applique
  // QU'à cette route précise — jamais à PUT /users/admin/:id/toggle-active (désactivation
  // générique, accès conservé, aucun WhatsApp).
  if (target.phone) {
    await sendWhatsAppTemplate(waselTemplates.account_blocked_fraud_oeil.template_name, target.phone, [suspensionReason]);
  }

  // Si l'utilisateur bloqué est un Œil avec des missions en cours, réattribution automatique
  // via la cascade de confirmation séquentielle partagée (transitionMission + advanceCandidateCascade),
  // même mécanisme que PUT /users/admin/:id/toggle-active — remplace l'ancien passage direct en
  // file d'attente prioritaire (bug corrigé, audit 2026-07-19 : héritage de l'ancien système
  // fast/choose, jamais migré vers la cascade lors du remplacement en commit f908f6c).
  // transfer_type toujours forcé à 'before' (jamais 'during', même si la mission était déjà
  // 'active'/'en_route') : un blocage anti-fraude ne doit produire aucun mouvement financier ni
  // split au prorata pour l'Œil bloqué. Contrairement à toggle-active, aucun message "aucune
  // pénalité" n'est envoyé à l'Œil ici — un blocage pour fraude reste une mesure punitive.
  let reassignedCount = 0;
  const { rows: strandedMissions } = await db.query(
    `SELECT * FROM missions WHERE oeil_id=$1 AND status IN ('assigned','en_route','active')`,
    [req.params.userId]
  );
  const graceMinutesQueue = await getSetting(db, 'transfer_grace_minutes_queue', 45);
  const graceMinutesOther = await getSetting(db, 'transfer_grace_minutes_other', 60);
  for (const mission of strandedMissions) {
    // Isolation par itération (O-BE-2) : un crash sur CETTE mission ne doit jamais abandonner
    // le reste du lot — même granularité que jobs/autoValidateMissions.js,
    // jobs/candidatureRelance.js et jobs/whatsappRetry.js.
    try {
      const graceMinutes = mission.type === 'file_attente' ? graceMinutesQueue : graceMinutesOther;
      const deadline = new Date(Date.now() + graceMinutes * 60 * 1000);
      let updated;
      try {
        updated = await transitionMission(db, mission.id, mission.status, 'pending', req.user.id, {
          extraFields: {
            is_priority: true,
            transfer_type: 'before',
            transferred_from: req.params.userId,
            transfer_reason: 'Compte prestataire bloqué pour fraude',
            transfer_deadline: deadline,
            oeil_id: null,
            batch_wave_count: 0,
            transfer_h30_no_show: false,
          },
          note: 'Réattribution automatique — Œil bloqué par un admin (anti-fraude)',
        });
      } catch (e) {
        if (e instanceof MissionTransitionError) continue; // statut déjà changé entre-temps
        throw e;
      }
      reassignedCount++;

      // Retire la propre candidature de l'Œil bloqué sur sa propre mission (même correctif que
      // POST /:id/transfer et toggle-active, voir bug fantôme audit 2.9) avant de lancer la cascade.
      await db.query(`DELETE FROM mission_interests WHERE mission_id=$1 AND oeil_id=$2`, [updated.id, req.params.userId]);

      await missionRoutes.advanceCandidateCascade(db, io, emitToUser, updated, {});

      // Formulation neutre côté client : ne mentionne ni blocage ni fraude.
      const title = '⚠️ Changement sur votre mission';
      const body = `Votre mission "${mission.title}" est en cours de réattribution suite à un changement côté prestataire. Nous recherchons un remplaçant en urgence.`;
      await db.query(
        `INSERT INTO notifications (user_id,title,body,type,mission_id,action_type,title_key,body_key,params) VALUES ($1,$2,$3,'info',$4,'mission_view',$5,$6,$7)`,
        [mission.client_id, title, body, mission.id, 'missionChangeAlertTitle', 'missionChangeAlertBody', JSON.stringify({ missionTitle: mission.title })]
      );
      if (emitToUser) emitToUser(mission.client_id, 'notification', { title, body });
    } catch (e) {
      console.error(`❌ POST /anti-fraud/block: réattribution mission ${mission.id} error:`, e.message);
    }
  }

  res.json({ message: 'Compte bloqué', user_id: req.params.userId, reassigned_missions: reassignedCount });
}));

// ── POST /anti-fraud/hold-withdrawal/:id ─────────────────
router.post('/hold-withdrawal/:id', authenticate, requireRole('admin'), requirePermission('finance'), asyncHandler(async (req, res) => {
  const db = getDb();
  // Même garde d'idempotence que PUT /admin/withdrawals/:id (users.js) : un virement déjà
  // 'paid'/'rejected' est un état terminal — le remettre en 'pending' rouvrirait la porte à
  // un double crédit (paid -> [remis pending] -> rejected recrédite alors que l'argent est
  // déjà parti par virement bancaire).
  const { rows: [w] } = await db.query(
    `UPDATE withdrawals SET status='pending', processed_by=NULL
     WHERE id=$1 AND status IN ('pending','approved') RETURNING *`,
    [req.params.id]
  );
  if (!w) {
    const { rows: [existing] } = await db.query('SELECT id FROM withdrawals WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Introuvable' });
    return res.status(409).json({ error: 'Ce virement a déjà été traité, impossible de le remettre en attente' });
  }
  res.json({ message: 'Virement mis en attente de vérification' });
}));

// ── GET /anti-fraud/rules ─────────────────────────────────
router.get('/rules', authenticate, requireRole('admin'), (req, res) => {
  res.json({ rules: Object.values(RULES) });
});

// Export analyzeUser for middleware use
module.exports = router;
module.exports.analyzeUser = analyzeUser;
