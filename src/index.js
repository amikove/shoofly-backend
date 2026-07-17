require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const jwt = require('jsonwebtoken');

const { initDb, getDb } = require('./db/schema');
const { logReliabilityEvent } = require('./utils/reliabilityScore');
const { getSetting } = require('./utils/settings');

const cron = require('node-cron');
const xss = require('xss-clean');
const hpp = require('hpp');
const mongoSanitize = require('express-mongo-sanitize');
const authRoutes    = require('./routes/auth');
const fraudRoutes      = require('./routes/antiFraud');
const superAdminRoutes = require('./routes/superAdmin');
const reliabilityRoutes = require('./routes/reliabilityRoutes');
const promoRoutes   = require('./routes/promo');
const missionRoutes = require('./routes/missions');
const missionRoutesModule = require('./routes/missions');
const checkTransferDeadlines = missionRoutesModule.checkTransferDeadlines;
const checkMissionEditRequestExpiry = missionRoutesModule.checkMissionEditRequestExpiry;
const hireOeilCore = missionRoutesModule.hireOeilCore;
const notify = missionRoutesModule.notify;
const mediaRoutes   = require('./routes/media');
const userRoutes    = require('./routes/users');
const reportRoutes = require('./routes/reports');
const ticketRoutes = require('./routes/tickets');

// ── CORS — liste blanche unique, source de vérité partagée par Express et Socket.IO ──
const productionOrigins = ['https://shoofly.netlify.app', 'https://shoofly-react.vercel.app'];
const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const allowedOrigins = [...productionOrigins, ...devOrigins];

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST']
  }
});

// ── Expose io to routes ───────────────────────────────────
app.set('io', io);

// ── Security & middleware ─────────────────────────────────

app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
}))
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin)
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  res.header('Access-Control-Allow-Credentials', 'true')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})


// Trust proxy — fix rate limit sur Render
app.set('trust proxy', 1);

// Rate limit global
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  skip: (req) => req.path === '/health',
  message: { error: 'Trop de requêtes, réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// Rate limit strict sur login — 10 tentatives / 15min par IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit sur upload — 20 uploads / 10min
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: { error: 'Trop d\'uploads. Réessayez dans 10 minutes.' },
});

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb' }));
app.use(xss());
app.use(hpp());
app.use(mongoSanitize());
app.use('/uploads', express.static(path.resolve(process.env.UPLOAD_DIR || './uploads')));

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth/login', loginLimiter);
app.use('/api/media',      uploadLimiter);
app.use('/api/auth',     authRoutes);
app.use('/api/missions', missionRoutes);
app.use('/api/media',    mediaRoutes);
app.use('/api/users',    userRoutes);
app.use('/api/anti-fraud', fraudRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/reliability', reliabilityRoutes);
app.use('/api/promo', promoRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/tickets', ticketRoutes);

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api', (_, res) => res.json({ name: 'SHOOFLY API', version: '1.0.0' }));
app.use((req, res) => res.status(404).json({ error: `Route introuvable: ${req.method} ${req.path}` }));
app.use((err, req, res, next) => {
  // Ne jamais exposer les détails en production
  const isDev = process.env.NODE_ENV !== 'production';
  console.error('❌', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Fichier trop volumineux (max 10MB)' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse' });
  res.status(err.status || 500).json({ error: isDev ? err.message : 'Une erreur est survenue. Veuillez réessayer.' });
});

// ── WebSocket ─────────────────────────────────────────────
// Map: userId → Set of socket ids
const userSockets = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Auth manquante'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = payload.id;
    socket.userRole = payload.role;
    next();
  } catch {
    next(new Error('Token invalide'));
  }
});

io.on('connection', (socket) => {
  const uid = socket.userId;
  if (!userSockets.has(uid)) userSockets.set(uid, new Set());
  userSockets.get(uid).add(socket.id);

  // Auto-join mission rooms this user is part of
  socket.on('join_mission', async (missionId) => {
  try {
    const db = getDb();
    const { rows: [mission] } = await db.query('SELECT client_id, oeil_id FROM missions WHERE id=$1', [missionId]);
    if (!mission) return;
    const { rows: [user] } = await db.query('SELECT role FROM users WHERE id=$1', [uid]);
    const isParty = mission.client_id === uid || mission.oeil_id === uid || user?.role === 'admin';
    if (!isParty) return;
    socket.join(`mission:${missionId}`);
  } catch (e) { console.error('WS join_mission error:', e.message); }
});

  socket.on('leave_mission', (missionId) => {
    socket.leave(`mission:${missionId}`);
  });

  // Client/Oeil sends a chat message via socket
  socket.on('send_message', async ({ missionId, content }) => {
    if (!content?.trim() || !missionId) return;
    try {
      const db = getDb();
      const mission = await db.query('SELECT * FROM missions WHERE id=$1', [missionId]);
      const m = mission.rows[0];
      if (!m) return;

      const canMsg = [m.client_id, m.oeil_id].includes(uid) || socket.userRole === 'admin';
      if (!canMsg) return;

      const result = await db.query(
        `INSERT INTO mission_messages (mission_id,sender_id,content,type) VALUES ($1,$2,$3,'text') RETURNING *`,
        [missionId, uid, content.trim()]
      );
      const sender = await db.query('SELECT first_name, last_name, role FROM users WHERE id=$1', [uid]);
      const msg = {
        ...result.rows[0],
        sender_name: `${sender.rows[0].first_name} ${sender.rows[0].last_name}`,
        sender_role: sender.rows[0].role,
      };

      // Broadcast to the mission room
      io.to(`mission:${missionId}`).emit('new_message', msg);

      // Notify the other party if offline
      const recipientId = uid === m.client_id ? m.oeil_id : m.client_id;
      if (recipientId && !userSockets.get(recipientId)?.size) {
        await db.query(
          `INSERT INTO notifications (user_id,title,body,type,mission_id,action_type,title_key,body_key,params) VALUES ($1,$2,$3,'message',$4,'chat',$5,$6,$7)`,
          [recipientId, `Message de ${sender.rows[0].first_name}`, content.trim().slice(0, 80), missionId, 'newMessageTitle', null, JSON.stringify({ senderName: sender.rows[0].first_name })]
        );
      }
    } catch (e) { console.error('WS message error:', e.message); }
  });

  // Oeil sends live GPS location
  socket.on('location_update', async ({ missionId, lat, lng }) => {
    if (!missionId || !lat || !lng) return;
    try {
      const db = getDb();
      await db.query(
        `UPDATE missions SET oeil_lat=$1, oeil_lng=$2, oeil_location_at=NOW() WHERE id=$3 AND oeil_id=$4`,
        [lat, lng, missionId, uid]
      );
      // Broadcast to mission room (client sees it live)
      io.to(`mission:${missionId}`).emit('location_update', { lat, lng, oeil_id: uid, timestamp: new Date() });
    } catch (e) { console.error('WS location error:', e.message); }
  });

  // mission_status_changed n'est plus écouté depuis le client — uniquement émis
    // côté serveur (routes/missions.js), pour empêcher un client de falsifier un statut.

  socket.on('disconnect', () => {
    userSockets.get(uid)?.delete(socket.id);
    if (!userSockets.get(uid)?.size) userSockets.delete(uid);
  });
});

// Helper: emit to a specific user across all their sockets

app.set('emitToUser', (userId, event, data) => {
  const sockets = userSockets.get(userId);
  console.log(`📡 emitToUser → ${userId} | sockets: ${sockets?.size || 0} | event: ${event}`);
  if (sockets) sockets.forEach(sid => io.to(sid).emit(event, data));
});

// ── Start ─────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;

initDb().then(() => {

  // Job toutes les heures — valider automatiquement les missions après 12h sans réclamation

  // Verrous anti-chevauchement en mémoire — un flag par cron, empêche une exécution
  // de démarrer si la précédente n'est pas terminée (process unique, pas de verrou distribué).
  let cronReminderJ1Running = false;
  let cronRecapAdminRunning = false;
  let cronAlertHRunning = false;
  let cronExpiredMissionsRunning = false;
  let cronPreMissionRemindersRunning = false;
  let cronTransferDeadlineRunning = false;
  let cronMissionEditExpiryRunning = false;
  let cronAutoValidateRunning = false;
  let cronStaleMissionsRunning = false;
  let cronCandidateWindowRunning = false;
  let cronTicketAutoResolveRunning = false;

// ── Cron J-1 20h — Rappel mission demain ─────────────────
  cron.schedule('0 20 * * *', async () => {
    if (cronReminderJ1Running) { console.warn('⏭️ Cron J-1 rappel déjà en cours, tick ignoré'); return; }
    cronReminderJ1Running = true;
    try {
      const db = getDb();
      const emitToUser = app.get('emitToUser');
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().slice(0, 10);

      const { rows: missions } = await db.query(`
        SELECT m.*, u.first_name, u.last_name
        FROM missions m
        JOIN users u ON u.id = m.oeil_id
        WHERE m.status IN ('assigned')
        AND DATE(m.scheduled_at) = $1
        AND m.oeil_id IS NOT NULL
      `, [dateStr]);

      for (const m of missions) {
        await db.query(
          `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
           VALUES ($1, $2, $3, 'warning', $4, 'mission_view', $5, $6, $7)`,
          [m.oeil_id,
           '⏰ Rappel mission demain',
           `Vous avez une mission demain : "${m.title}" à ${new Date(m.scheduled_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}. Confirmez votre présence en étant à l'heure.`,
           m.id,
           'missionReminderTomorrowTitle',
           'missionReminderTomorrowBody',
           JSON.stringify({ missionTitle: m.title, time: new Date(m.scheduled_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) })]
        );
        if (emitToUser) emitToUser(m.oeil_id, 'notification', {
          title: '⏰ Rappel mission demain',
          body: `Mission demain : "${m.title}"`,
          missionId: m.id,
          type: 'warning'
        });
        console.log(`⏰ Rappel J-1 envoyé pour mission ${m.id}`);
      }
    } catch (e) { console.error('❌ Cron J-1 rappel error:', e.message); }
    finally { cronReminderJ1Running = false; }
  });

  // ── Cron J-1 22h — Email récap admin non-confirmations ───
  cron.schedule('0 22 * * *', async () => {
    if (cronRecapAdminRunning) { console.warn('⏭️ Cron récap admin déjà en cours, tick ignoré'); return; }
    cronRecapAdminRunning = true;
    try {
      const db = getDb();
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().slice(0, 10);

      const { rows: missions } = await db.query(`
        SELECT m.*, 
          u.first_name AS oeil_first, u.last_name AS oeil_last, u.phone AS oeil_phone,
          c.first_name AS client_first, c.last_name AS client_last
        FROM missions m
        JOIN users u ON u.id = m.oeil_id
        JOIN users c ON c.id = m.client_id
        WHERE m.status IN ('assigned')
        AND DATE(m.scheduled_at) = $1
        AND m.oeil_id IS NOT NULL
        ORDER BY m.city, m.quartier
      `, [dateStr]);

      if (missions.length === 0) return;

      // Grouper par ville
      const grouped = missions.reduce((acc, m) => {
        const key = `${m.city} — ${m.quartier || 'Sans quartier'}`;
        if (!acc[key]) acc[key] = [];
        acc[key].push(m);
        return acc;
      }, {});

      // Construire le corps de l'email
      let body = `Récapitulatif missions du ${tomorrow.toLocaleDateString('fr-FR')} — ${missions.length} mission(s) en attente de confirmation\n\n`;
      for (const [zone, ms] of Object.entries(grouped)) {
        body += `📍 ${zone}\n`;
        for (const m of ms) {
          body += `  • ${m.title} — ${new Date(m.scheduled_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}\n`;
          body += `    Œil : ${m.oeil_first} ${m.oeil_last} (${m.oeil_phone})\n`;
          body += `    Client : ${m.client_first} ${m.client_last}\n\n`;
        }
      }

      // Notification in-app admin
      const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
      for (const admin of admins) {
        await db.query(
          `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
           VALUES ($1, $2, $3, 'warning', 'admin_missions', $4, $5, $6)`,
          [admin.id,
           `📋 ${missions.length} mission(s) non confirmées demain`,
           body,
           'adminMissionsRecapTitle',
           null,
           JSON.stringify({ count: missions.length })]
        );
      }
      console.log(`📋 Récap admin envoyé — ${missions.length} missions demain`);
    } catch (e) { console.error('❌ Cron récap admin error:', e.message); }
    finally { cronRecapAdminRunning = false; }
  });

  // ── Cron toutes les heures — Alertes H et H+30 ───────────
  cron.schedule('*/30 * * * *', async () => {
    if (cronAlertHRunning) { console.warn('⏭️ Cron alertes H/H+30 déjà en cours, tick ignoré'); return; }
    cronAlertHRunning = true;
    try {
      const db = getDb();
      const emitToUser = app.get('emitToUser');
      const now = new Date();
      const alertWindowMinutes = await getSetting(db, 'late_start_alert_window_minutes', 30);
      const autoTransferMinutes = await getSetting(db, 'late_start_auto_transfer_minutes', 60);

      // Missions qui auraient dû démarrer il y a 0-30 min (H)
      const { rows: lateH } = await db.query(`
        SELECT m.*, u.first_name, u.last_name
        FROM missions m
        JOIN users u ON u.id = m.oeil_id
        WHERE m.status = 'assigned'
        AND m.scheduled_at BETWEEN NOW() - INTERVAL '1 minute' * $1::numeric AND NOW()
        AND m.oeil_id IS NOT NULL
      `, [alertWindowMinutes]);

      for (const m of lateH) {
        // Alerte Œil
        await db.query(
          `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
           VALUES ($1, '🚨 Votre mission a commencé !', $2, 'error', $3, 'mission_view', $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [m.oeil_id, `La mission "${m.title}" devait commencer maintenant. Mettez à jour votre statut immédiatement.`, m.id,
           'missionStartedAlertTitle', 'missionStartedAlertBody', JSON.stringify({ missionTitle: m.title })]
        );
        // Alerte admin
        const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
        for (const admin of admins) {
          await db.query(
            `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
             VALUES ($1, '🚨 Mission non démarrée', $2, 'error', $3, 'admin_missions', $4, $5, $6)`,
            [admin.id, `L'Œil ${m.first_name} ${m.last_name} n'a pas démarré "${m.title}" à l'heure prévue.`, m.id,
             'missionNotStartedAdminTitle', 'missionNotStartedAdminBody', JSON.stringify({ oeilName: `${m.first_name} ${m.last_name}`, missionTitle: m.title })]
          );
        }
        if (emitToUser) emitToUser(m.oeil_id, 'notification', {
          title: '🚨 Mission non démarrée',
          body: `"${m.title}" devait commencer maintenant !`,
          missionId: m.id,
          type: 'error'
        });
        console.log(`🚨 Alerte H pour mission ${m.id}`);
      }

      // Missions H+30min → transfert automatique
      const { rows: lateH30 } = await db.query(`
        SELECT m.*, u.first_name, u.last_name
        FROM missions m
        JOIN users u ON u.id = m.oeil_id
        WHERE m.status = 'assigned'
        AND m.scheduled_at BETWEEN NOW() - INTERVAL '1 minute' * $1::numeric AND NOW() - INTERVAL '1 minute' * $2::numeric
        AND m.oeil_id IS NOT NULL
        AND m.is_priority = false
      `, [autoTransferMinutes, alertWindowMinutes]);

      const transferCooldownHours = await getSetting(db, 'transfer_cooldown_hours', 4);
      for (const m of lateH30) {
        // Pénalité fiabilité — le score est entièrement recalculé par logReliabilityEvent ci-dessous,
        // pas besoin de le décrémenter manuellement ici (ancien code mort, toujours écrasé après coup).
        await db.query(
          `UPDATE users SET
            transfer_cooldown_until = NOW() + INTERVAL '1 hour' * $1::numeric,
            transfer_count = transfer_count + 1
           WHERE id = $2`,
          [transferCooldownHours, m.oeil_id]
        );
      await db.query(`INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'debit',100,'Pénalité — mission non démarrée à l''heure',$2)`, [m.oeil_id, m.id]);
        await db.query(`UPDATE oeil_profiles SET balance=GREATEST(0,balance-100) WHERE user_id=$1`, [m.oeil_id]);
        await logReliabilityEvent(db, m.oeil_id, m.id, -20, 'Mission non démarrée à l\'heure (H+30)', true);

        // Transfert automatique
        const graceMinutesQueue = await getSetting(db, 'transfer_grace_minutes_queue', 45);
        const graceMinutesOther = await getSetting(db, 'transfer_grace_minutes_other', 60);
        const graceMinutes = m.type === 'file_attente' ? graceMinutesQueue : graceMinutesOther;
        const deadline = new Date(Date.now() + graceMinutes * 60 * 1000);
        await db.query(`
          UPDATE missions SET
            status='pending', is_priority=true,
            transfer_type='before', transferred_from=$1,
            transfer_reason='Mission non démarrée à l''heure — transfert automatique',
            transfer_deadline=$2, oeil_id=NULL, updated_at=NOW()
          WHERE id=$3
        `, [m.oeil_id, deadline, m.id]);

        // Remboursement client si pas de remplaçant (géré par cron deadline)
        await db.query(
          `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
           VALUES ($1, '⚠️ Mission transférée automatiquement', $2, 'warning', $3, 'mission_view', $4, $5, $6)`,
          [m.client_id, `Votre Œil n'a pas démarré "${m.title}" à l'heure. Nous recherchons un remplaçant en urgence.`, m.id,
           'missionAutoTransferredClientTitle', 'missionAutoTransferredClientBody', JSON.stringify({ missionTitle: m.title })]
        );
        await db.query(
          `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
           VALUES ($1, '⚠️ Pénalité appliquée', $2, 'error', $3, 'reliability_page', $4, $5, $6)`,
          [m.oeil_id, `Vous n'avez pas démarré "${m.title}" à l'heure. -100 MAD déduits et cooldown 4h appliqué.`, m.id,
           'penaltyAppliedTitle', 'penaltyAppliedBody', JSON.stringify({ missionTitle: m.title })]
        );

        const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
        for (const admin of admins) {
          await db.query(
            `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
             VALUES ($1, '🔄 Transfert automatique H+30', $2, 'warning', $3, 'admin_missions', $4, $5, $6)`,
            [admin.id, `Mission "${m.title}" transférée automatiquement — Œil ${m.first_name} ${m.last_name} n'a pas démarré.`, m.id,
             'autoTransferAdminTitle', 'autoTransferAdminBody', JSON.stringify({ missionTitle: m.title, oeilName: `${m.first_name} ${m.last_name}` })]
          );
        }
        console.log(`🔄 Transfert auto H+30 pour mission ${m.id}`);
      }

    } catch (e) { console.error('❌ Cron H/H+30 error:', e.message); }
    finally { cronAlertHRunning = false; }
  });

  // ── Cron toutes les heures — Missions expirées (niveau 3) ─
  cron.schedule('0 * * * *', async () => {
    if (cronExpiredMissionsRunning) { console.warn('⏭️ Cron missions expirées déjà en cours, tick ignoré'); return; }
    cronExpiredMissionsRunning = true;
    try {
      const db = getDb();
      const emitToUser = app.get('emitToUser');
      const overdueVerificationHours = await getSetting(db, 'mission_overdue_verification_hours', 24);

      // Missions active/en_route depuis plus de 24h après scheduled_at
      const { rows: expired } = await db.query(`
        SELECT m.*, u.first_name, u.last_name
        FROM missions m
        JOIN users u ON u.id = m.oeil_id
        WHERE m.status IN ('active', 'en_route')
        AND m.scheduled_at < NOW() - INTERVAL '1 hour' * $1::numeric
        AND m.oeil_id IS NOT NULL
      `, [overdueVerificationHours]);

      for (const m of expired) {
        const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
        for (const admin of admins) {
          await db.query(
            `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
             VALUES ($1, '🔍 Mission à vérifier', $2, 'warning', $3, 'admin_missions', $4, $5, $6)
             ON CONFLICT DO NOTHING`,
            [admin.id, `La mission "${m.title}" de ${m.first_name} ${m.last_name} est en cours depuis plus de 24h. Vérification requise.`, m.id,
             'missionToVerifyAdminTitle', 'missionToVerifyAdminBody', JSON.stringify({ missionTitle: m.title, oeilName: `${m.first_name} ${m.last_name}` })]
          );
        }
        console.log(`🔍 Alerte mission expirée ${m.id}`);
      }
    } catch (e) { console.error('❌ Cron missions expirées error:', e.message); }
    finally { cronExpiredMissionsRunning = false; }
  });

  // ── Cron J H-2h et H-30min — Rappels avant mission ──────
  cron.schedule('*/30 * * * *', async () => {
    if (cronPreMissionRemindersRunning) { console.warn('⏭️ Cron rappels avant mission déjà en cours, tick ignoré'); return; }
    cronPreMissionRemindersRunning = true;
    try {
      const db = getDb();
      const emitToUser = app.get('emitToUser');
      const reminderEarlyMinutes = await getSetting(db, 'reminder_before_mission_minutes_early', 120);
      const reminderLateMinutes = await getSetting(db, 'reminder_before_mission_minutes_late', 30);

      // H-2h (marge ±10min, dimensionnée pour la fréquence du cron */30 * * * *)
      const { rows: missions2h } = await db.query(`
        SELECT m.* FROM missions m
        WHERE m.status = 'assigned'
        AND m.scheduled_at BETWEEN NOW() + INTERVAL '1 minute' * $1::numeric AND NOW() + INTERVAL '1 minute' * $2::numeric
        AND m.oeil_id IS NOT NULL
      `, [reminderEarlyMinutes - 10, reminderEarlyMinutes + 10]);
      for (const m of missions2h) {
        await db.query(
          `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
           VALUES ($1, '⏰ Mission dans 2 heures', $2, 'warning', $3, 'mission_view', $4, $5, $6)`,
          [m.oeil_id, `Votre mission "${m.title}" commence dans 2 heures. Préparez-vous !`, m.id,
           'missionIn2HoursTitle', 'missionIn2HoursBody', JSON.stringify({ missionTitle: m.title })]
        );
        if (emitToUser) emitToUser(m.oeil_id, 'notification', {
          title: '⏰ Mission dans 2 heures',
          body: `"${m.title}" commence bientôt`,
          missionId: m.id,
          type: 'warning'
        });
      }

      // H-30min (marge ±10min)
      const { rows: missions30 } = await db.query(`
        SELECT m.* FROM missions m
        WHERE m.status = 'assigned'
        AND m.scheduled_at BETWEEN NOW() + INTERVAL '1 minute' * $1::numeric AND NOW() + INTERVAL '1 minute' * $2::numeric
        AND m.oeil_id IS NOT NULL
      `, [reminderLateMinutes - 10, reminderLateMinutes + 10]);
      for (const m of missions30) {
        await db.query(
          `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
           VALUES ($1, '🚀 Mission dans 30 minutes !', $2, 'warning', $3, 'mission_view', $4, $5, $6)`,
          [m.oeil_id, `Votre mission "${m.title}" commence dans 30 minutes. Êtes-vous en route ?`, m.id,
           'missionIn30MinutesTitle', 'missionIn30MinutesBody', JSON.stringify({ missionTitle: m.title })]
        );
        if (emitToUser) emitToUser(m.oeil_id, 'notification', {
          title: '🚀 Mission dans 30 minutes !',
          body: `"${m.title}" — Êtes-vous en route ?`,
          missionId: m.id,
          type: 'warning'
        });
        // Alerte admin si H-30min
        const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
        for (const admin of admins) {
          await db.query(
            `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
             VALUES ($1, '⚠️ Mission dans 30 min non confirmée', $2, 'warning', $3, 'admin_missions', $4, $5, $6)`,
            [admin.id, `Mission "${m.title}" dans 30 min — l'Œil n'a pas encore démarré.`, m.id,
             'missionNotConfirmedAdminTitle', 'missionNotConfirmedAdminBody', JSON.stringify({ missionTitle: m.title })]
          );
        }
      }
    } catch (e) { console.error('❌ Cron rappels error:', e.message); }
    finally { cronPreMissionRemindersRunning = false; }
  });

  // Vérifier deadlines transfert toutes les 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    if (cronTransferDeadlineRunning) { console.warn('⏭️ Cron deadlines transfert déjà en cours, tick ignoré'); return; }
    cronTransferDeadlineRunning = true;
    try {
      const db = getDb();
      const emitToUser = app.get('emitToUser');
      await checkTransferDeadlines(db, emitToUser);
    } catch (e) { console.error('❌ Transfer deadline cron error:', e.message); }
    finally { cronTransferDeadlineRunning = false; }
  });

  // Expirer les demandes de modification de mission sans réponse de l'Œil toutes les 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    if (cronMissionEditExpiryRunning) { console.warn('⏭️ Cron expiration demandes de modification déjà en cours, tick ignoré'); return; }
    cronMissionEditExpiryRunning = true;
    try {
      const db = getDb();
      const emitToUser = app.get('emitToUser');
      await checkMissionEditRequestExpiry(db, emitToUser);
    } catch (e) { console.error('❌ Mission edit request expiry cron error:', e.message); }
    finally { cronMissionEditExpiryRunning = false; }
  });

  // ── Cron toutes les 2 min — Sélection automatique de candidat à expiration
  // de la fenêtre de candidature (fast : 10min fixe / choose : 5 ou 10min) ──
  cron.schedule('*/2 * * * *', async () => {
    if (cronCandidateWindowRunning) { console.warn('⏭️ Cron sélection candidat déjà en cours, tick ignoré'); return; }
    cronCandidateWindowRunning = true;
    try {
      const db = getDb();
      const io = app.get('io');
      const emitToUser = app.get('emitToUser');

      const { rows: expiredWindows } = await db.query(`
        SELECT * FROM missions
        WHERE candidate_window_ends_at IS NOT NULL
          AND candidate_window_ends_at <= NOW()
          AND status='pending'
          AND oeil_id IS NULL
      `);

      for (const mission of expiredWindows) {
        // Classement des candidats : reliability_score décroissant, puis rating_avg décroissant
        const { rows: candidates } = await db.query(`
          SELECT u.id
          FROM mission_interests mi
          JOIN users u ON u.id = mi.oeil_id
          LEFT JOIN oeil_profiles p ON p.user_id = u.id
          WHERE mi.mission_id = $1
          ORDER BY u.reliability_score DESC, p.rating_avg DESC
        `, [mission.id]);

        let assigned = null;
        for (const candidate of candidates) {
          // Si le meilleur candidat échoue une vérification (suspension/cooldown/créneau),
          // on tente le suivant du classement plutôt que d'échouer silencieusement.
          const result = await hireOeilCore(db, io, emitToUser, mission, candidate.id, {
            changedById: null,
            historyNote: 'Sélection automatique du meilleur candidat (fin de fenêtre de candidature)',
            oeilNotifTitle: '🎉 Vous avez été sélectionné !',
            oeilNotifBody: `Vous avez été automatiquement retenu comme remplaçant pour "${mission.title}".`,
          });
          if (result.ok) { assigned = result.mission; break; }
        }

        if (assigned) {
          const { rows: [oeil] } = await db.query('SELECT first_name, last_name FROM users WHERE id=$1', [assigned.oeil_id]);
          await notify(db, mission.client_id, '✅ Remplaçant trouvé',
            `${oeil.first_name} ${oeil.last_name} a été automatiquement sélectionné pour remplacer sur "${mission.title}".`,
            'mission', mission.id, emitToUser);
          console.log(`✅ Sélection automatique — mission ${mission.id} assignée à ${assigned.oeil_id}`);
        } else {
          // Aucun candidat (ou tous invalides) : on ne touche à rien d'autre, le
          // transfer_deadline existant continue de courir en toile de fond.
          await db.query(`UPDATE missions SET candidate_window_ends_at=NULL WHERE id=$1`, [mission.id]);
          console.log(`ℹ️ Fenêtre de candidature expirée sans candidat valide — mission ${mission.id}`);
        }
      }
    } catch (e) { console.error('❌ Cron sélection candidat error:', e.message); }
    finally { cronCandidateWindowRunning = false; }
  });

  cron.schedule('0 * * * *', async () => {
    if (cronAutoValidateRunning) { console.warn('⏭️ Cron auto-validation déjà en cours, tick ignoré'); return; }
    cronAutoValidateRunning = true;
    try {
      const db = getDb();
      const clientValidationHours = await getSetting(db, 'client_validation_hours', 12);
      const { rows: missions } = await db.query(`
        SELECT * FROM missions
        WHERE status='completed'
          AND completed_by_oeil_at IS NOT NULL
          AND completed_by_oeil_at < NOW() - INTERVAL '1 hour' * $1::numeric
          AND validated_at IS NULL
      `, [clientValidationHours]);
      for (const mission of missions) {
        // Le statut a pu changer entre le SELECT et ici (ex: réclamation déposée
        // entre-temps) — la garde sur le WHERE évite de payer une mission qui n'est
        // plus 'completed'.
        const { rowCount } = await db.query(
          `UPDATE missions SET validated_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='completed'`,
          [mission.id]
        );
        if (rowCount === 0) {
          console.log(`ℹ️ Auto-validation ignorée pour mission ${mission.id} : statut a changé entre-temps`);
          continue;
        }
        await db.query(`UPDATE oeil_profiles SET balance=balance+$1, total_earnings=total_earnings+$1 WHERE user_id=$2`, [mission.oeil_earning, mission.oeil_id]);
        await db.query(`INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,'Validation automatique après 12h',$3)`, [mission.oeil_id, mission.oeil_earning, mission.id]);
        console.log(`✅ Auto-validé mission ${mission.id}`);
      }
    } catch (e) { console.error('❌ Cron error:', e.message); }
    finally { cronAutoValidateRunning = false; }
  });

  // ── Cron toutes les 30 min — Missions jamais assignées (12h+, encore >4h avant le créneau) ──
  cron.schedule('*/30 * * * *', async () => {
    if (cronStaleMissionsRunning) { console.warn('⏭️ Cron missions sans Œil déjà en cours, tick ignoré'); return; }
    cronStaleMissionsRunning = true;
    try {
      const db = getDb();
      const staleMissionHours = await getSetting(db, 'stale_mission_hours', 12);
      const staleMissionMinLeadHours = await getSetting(db, 'stale_mission_min_lead_hours', 4);

      const { rows: staleMissions } = await db.query(`
        SELECT * FROM missions
        WHERE status = 'pending'
          AND oeil_id IS NULL
          AND created_at <= NOW() - INTERVAL '1 hour' * $1::numeric
          AND scheduled_at >= NOW() + INTERVAL '1 hour' * $2::numeric
          AND stale_notified_at IS NULL
      `, [staleMissionHours, staleMissionMinLeadHours]);

      for (const m of staleMissions) {
          // Notification admin uniquement — la suggestion client (augmenter le budget) a été retirée :
          // aucune page d'édition de mission n'existe encore pour que le client agisse dessus.
          // TODO : ajouter aussi un envoi WhatsApp automatique à l'admin une fois un compte WhatsApp
          // Business API configuré (Badr SMS, OrangeSMS Maroc, ou Yobota — déjà étudiés précédemment).
          const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
          for (const admin of admins) {
            await db.query(
              `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
               VALUES ($1, $2, $3, 'warning', $4, 'admin_missions', $5, $6, $7)`,
              [admin.id, '⏳ Mission sans Œil depuis 12h', `Aucun Œil n'a encore été trouvé pour "${m.title}", en attente depuis plus de 12h.`, m.id,
               'staleMissionAdminTitle', 'staleMissionAdminBody', JSON.stringify({ missionTitle: m.title })]
            );
          }
          await db.query(`UPDATE missions SET stale_notified_at = NOW() WHERE id = $1`, [m.id]);
          console.log(`⏳ Notification mission sans Œil envoyée pour ${m.id}`);
        }
    } catch (e) { console.error('❌ Cron missions sans Œil error:', e.message); }
    finally { cronStaleMissionsRunning = false; }
  });

  // ── Cron toutes les heures — auto-résolution des tickets après 72h d'inactivité ──
  // IMPORTANT : is_urgent=true est EXCLU explicitement de la requête (jamais concerné
  // par cette auto-résolution, quelle que soit la durée d'inactivité).
  cron.schedule('0 * * * *', async () => {
    if (cronTicketAutoResolveRunning) { console.warn('⏭️ Cron auto-résolution tickets déjà en cours, tick ignoré'); return; }
    cronTicketAutoResolveRunning = true;
    try {
      const db = getDb();
      const emitToUser = app.get('emitToUser');
      const ticketAutoResolveHours = await getSetting(db, 'ticket_auto_resolve_hours', 72);

      const { rows: tickets } = await db.query(`
        SELECT * FROM support_tickets
        WHERE status = 'in_progress'
          AND is_urgent = false
          AND last_admin_message_at IS NOT NULL
          AND last_admin_message_at > COALESCE(last_user_message_at, '1970-01-01')
          AND last_admin_message_at <= NOW() - INTERVAL '1 hour' * $1::numeric
      `, [ticketAutoResolveHours]);

      // ticket_messages.sender_id référence users(id) sans exception "système" — on
      // attribue donc le message automatique à un admin actif (peu importe lequel : le
      // flag is_system=true est ce qui fait foi côté affichage, pas le sender_id).
      let systemSenderId = null;
      if (tickets.length) {
        const { rows: [anyAdmin] } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true LIMIT 1`);
        systemSenderId = anyAdmin ? anyAdmin.id : null;
      }

      for (const ticket of tickets) {
        if (!systemSenderId) { console.warn('⏭️ Cron auto-résolution tickets : aucun admin actif trouvé, tick ignoré'); break; }
        await db.query(
          `UPDATE support_tickets SET status='resolved', resolved_by=NULL, resolved_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [ticket.id]
        );
        await db.query(
          `INSERT INTO ticket_messages (ticket_id, sender_id, sender_role, content, is_system)
           VALUES ($1, $2, 'admin', 'Ticket résolu automatiquement après 72h sans réponse de votre part.', true)`,
          [ticket.id, systemSenderId]
        );
        await notify(
          db, ticket.user_id,
          `📋 Ticket ${ticket.reference} résolu automatiquement`,
          'Aucune réponse de votre part depuis 72h — le ticket a été résolu automatiquement. Vous pouvez le rouvrir en répondant.',
          'info', ticket.mission_id, emitToUser, 'ticket_view',
          'ticketAutoResolvedTitle', 'ticketAutoResolvedBody', { reference: ticket.reference, ticketId: ticket.id }
        );
        console.log(`📋 Ticket ${ticket.reference} auto-résolu après 72h d'inactivité`);
      }
    } catch (e) { console.error('❌ Cron auto-résolution tickets error:', e.message); }
    finally { cronTicketAutoResolveRunning = false; }
  });

  // Keep-alive pour Render plan gratuit
if (process.env.NODE_ENV === 'production') {
  setInterval(() => {
    require('https').get('https://shoofly-api.onrender.com/health', () => {})
  }, 10 * 60 * 1000) // toutes les 10 minutes
}

  server.listen(PORT, () => {
    console.log(`\n🚀 SHOOFLY API + WebSocket on port ${PORT}`);
    console.log(`   Health  : http://localhost:${PORT}/health`);
    console.log(`   WS      : ws://localhost:${PORT}\n`);
  });
}).catch(e => {
  console.error('❌ DB init failed:', e.message);
  process.exit(1);
});

module.exports = { app, io };
