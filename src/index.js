require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const jwt = require('jsonwebtoken');

const { initDb, getDb } = require('./db/schema');
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
const mediaRoutes   = require('./routes/media');
const userRoutes    = require('./routes/users');
const reportRoutes = require('./routes/reports');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  
 cors: { 
  origin: ['https://shoofly.netlify.app', 'https://shoofly-react.vercel.app'],
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
  const allowedOrigins = ['https://shoofly.netlify.app', 'https://shoofly-react.vercel.app']
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
  socket.on('join_mission', (missionId) => {
    socket.join(`mission:${missionId}`);
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
          `INSERT INTO notifications (user_id,title,body,type,mission_id) VALUES ($1,$2,$3,'message',$4)`,
          [recipientId, `Message de ${sender.rows[0].first_name}`, content.trim().slice(0, 80), missionId]
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

  // Admin or system broadcasts mission status change
  socket.on('mission_status_changed', ({ missionId, status }) => {
    io.to(`mission:${missionId}`).emit('mission_status_changed', { missionId, status });
  });

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

// ── Cron J-1 20h — Rappel mission demain ─────────────────
  cron.schedule('0 20 * * *', async () => {
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
          `INSERT INTO notifications (user_id, title, body, type, mission_id)
           VALUES ($1, $2, $3, 'warning', $4)`,
          [m.oeil_id,
           '⏰ Rappel mission demain',
           `Vous avez une mission demain : "${m.title}" à ${new Date(m.scheduled_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}. Confirmez votre présence en étant à l'heure.`,
           m.id]
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
  });

  // ── Cron J-1 22h — Email récap admin non-confirmations ───
  cron.schedule('0 22 * * *', async () => {
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
          `INSERT INTO notifications (user_id, title, body, type)
           VALUES ($1, $2, $3, 'warning')`,
          [admin.id,
           `📋 ${missions.length} mission(s) non confirmées demain`,
           body]
        );
      }
      console.log(`📋 Récap admin envoyé — ${missions.length} missions demain`);
    } catch (e) { console.error('❌ Cron récap admin error:', e.message); }
  });

  // ── Cron toutes les heures — Alertes H et H+30 ───────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      const db = getDb();
      const emitToUser = app.get('emitToUser');
      const now = new Date();

      // Missions qui auraient dû démarrer il y a 0-30 min (H)
      const { rows: lateH } = await db.query(`
        SELECT m.*, u.first_name, u.last_name
        FROM missions m
        JOIN users u ON u.id = m.oeil_id
        WHERE m.status = 'assigned'
        AND m.scheduled_at BETWEEN NOW() - INTERVAL '30 minutes' AND NOW()
        AND m.oeil_id IS NOT NULL
      `);

      for (const m of lateH) {
        // Alerte Œil
        await db.query(
          `INSERT INTO notifications (user_id, title, body, type, mission_id)
           VALUES ($1, '🚨 Votre mission a commencé !', $2, 'error', $3)
           ON CONFLICT DO NOTHING`,
          [m.oeil_id, `La mission "${m.title}" devait commencer maintenant. Mettez à jour votre statut immédiatement.`, m.id]
        );
        // Alerte admin
        const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
        for (const admin of admins) {
          await db.query(
            `INSERT INTO notifications (user_id, title, body, type, mission_id)
             VALUES ($1, '🚨 Mission non démarrée', $2, 'error', $3)`,
            [admin.id, `L'Œil ${m.first_name} ${m.last_name} n'a pas démarré "${m.title}" à l'heure prévue.`, m.id]
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
        AND m.scheduled_at BETWEEN NOW() - INTERVAL '60 minutes' AND NOW() - INTERVAL '30 minutes'
        AND m.oeil_id IS NOT NULL
        AND m.is_priority = false
      `);

      for (const m of lateH30) {
        // Pénalité fiabilité
        await db.query(
          `UPDATE users SET
            reliability_score = GREATEST(0, reliability_score - 20),
            transfer_cooldown_until = NOW() + INTERVAL '4 hours',
            transfer_count = transfer_count + 1
           WHERE id = $1`,
          [m.oeil_id]
        );
        await db.query(`INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'debit',100,'Pénalité — mission non démarrée à l''heure',$2)`, [m.oeil_id, m.id]);
        await db.query(`UPDATE users SET balance=GREATEST(0,balance-100) WHERE id=$1`, [m.oeil_id]);

        // Transfert automatique
        const graceMinutes = m.type === 'file_attente' ? 45 : 60;
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
          `INSERT INTO notifications (user_id, title, body, type, mission_id)
           VALUES ($1, '⚠️ Mission transférée automatiquement', $2, 'warning', $3)`,
          [m.client_id, `Votre Œil n'a pas démarré "${m.title}" à l'heure. Nous recherchons un remplaçant en urgence.`, m.id]
        );
        await db.query(
          `INSERT INTO notifications (user_id, title, body, type, mission_id)
           VALUES ($1, '⚠️ Pénalité appliquée', $2, 'error', $3)`,
          [m.oeil_id, `Vous n'avez pas démarré "${m.title}" à l'heure. -100 MAD déduits et cooldown 4h appliqué.`, m.id]
        );

        const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
        for (const admin of admins) {
          await db.query(
            `INSERT INTO notifications (user_id, title, body, type, mission_id)
             VALUES ($1, '🔄 Transfert automatique H+30', $2, 'warning', $3)`,
            [admin.id, `Mission "${m.title}" transférée automatiquement — Œil ${m.first_name} ${m.last_name} n'a pas démarré.`, m.id]
          );
        }
        console.log(`🔄 Transfert auto H+30 pour mission ${m.id}`);
      }

    } catch (e) { console.error('❌ Cron H/H+30 error:', e.message); }
  });

  // ── Cron toutes les heures — Missions expirées (niveau 3) ─
  cron.schedule('0 * * * *', async () => {
    try {
      const db = getDb();
      const emitToUser = app.get('emitToUser');

      // Missions active/en_route depuis plus de 24h après scheduled_at
      const { rows: expired } = await db.query(`
        SELECT m.*, u.first_name, u.last_name
        FROM missions m
        JOIN users u ON u.id = m.oeil_id
        WHERE m.status IN ('active', 'en_route')
        AND m.scheduled_at < NOW() - INTERVAL '24 hours'
        AND m.oeil_id IS NOT NULL
      `);

      for (const m of expired) {
        const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
        for (const admin of admins) {
          await db.query(
            `INSERT INTO notifications (user_id, title, body, type, mission_id)
             VALUES ($1, '🔍 Mission à vérifier', $2, 'warning', $3)
             ON CONFLICT DO NOTHING`,
            [admin.id, `La mission "${m.title}" de ${m.first_name} ${m.last_name} est en cours depuis plus de 24h. Vérification requise.`, m.id]
          );
        }
        console.log(`🔍 Alerte mission expirée ${m.id}`);
      }
    } catch (e) { console.error('❌ Cron missions expirées error:', e.message); }
  });

  // ── Cron J H-2h et H-30min — Rappels avant mission ──────
  cron.schedule('*/30 * * * *', async () => {
    try {
      const db = getDb();
      const emitToUser = app.get('emitToUser');

      // H-2h
      const { rows: missions2h } = await db.query(`
        SELECT m.* FROM missions m
        WHERE m.status = 'assigned'
        AND m.scheduled_at BETWEEN NOW() + INTERVAL '1h50m' AND NOW() + INTERVAL '2h10m'
        AND m.oeil_id IS NOT NULL
      `);
      for (const m of missions2h) {
        await db.query(
          `INSERT INTO notifications (user_id, title, body, type, mission_id)
           VALUES ($1, '⏰ Mission dans 2 heures', $2, 'warning', $3)`,
          [m.oeil_id, `Votre mission "${m.title}" commence dans 2 heures. Préparez-vous !`, m.id]
        );
        if (emitToUser) emitToUser(m.oeil_id, 'notification', {
          title: '⏰ Mission dans 2 heures',
          body: `"${m.title}" commence bientôt`,
          missionId: m.id,
          type: 'warning'
        });
      }

      // H-30min
      const { rows: missions30 } = await db.query(`
        SELECT m.* FROM missions m
        WHERE m.status = 'assigned'
        AND m.scheduled_at BETWEEN NOW() + INTERVAL '20m' AND NOW() + INTERVAL '40m'
        AND m.oeil_id IS NOT NULL
      `);
      for (const m of missions30) {
        await db.query(
          `INSERT INTO notifications (user_id, title, body, type, mission_id)
           VALUES ($1, '🚀 Mission dans 30 minutes !', $2, 'warning', $3)`,
          [m.oeil_id, `Votre mission "${m.title}" commence dans 30 minutes. Êtes-vous en route ?`, m.id]
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
            `INSERT INTO notifications (user_id, title, body, type, mission_id)
             VALUES ($1, '⚠️ Mission dans 30 min non confirmée', $2, 'warning', $3)`,
            [admin.id, `Mission "${m.title}" dans 30 min — l'Œil n'a pas encore démarré.`, m.id]
          );
        }
      }
    } catch (e) { console.error('❌ Cron rappels error:', e.message); }
  });

  // Vérifier deadlines transfert toutes les 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const db = getDb();
      const emitToUser = app.get('emitToUser');
      await checkTransferDeadlines(db, emitToUser);
    } catch (e) { console.error('❌ Transfer deadline cron error:', e.message); }
  });

  cron.schedule('0 * * * *', async () => {
    try {
      const db = getDb();
      const { rows: missions } = await db.query(`
        SELECT * FROM missions
        WHERE status='completed'
          AND completed_by_oeil_at IS NOT NULL
          AND completed_by_oeil_at < NOW() - INTERVAL '12 hours'
          AND validated_at IS NULL
      `);
      for (const mission of missions) {
        await db.query(`UPDATE missions SET validated_at=NOW(), updated_at=NOW() WHERE id=$1`, [mission.id]);
        await db.query(`UPDATE oeil_profiles SET balance=balance+$1, total_earnings=total_earnings+$1 WHERE user_id=$2`, [mission.oeil_earning, mission.oeil_id]);
        await db.query(`INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,'Validation automatique après 12h',$3)`, [mission.oeil_id, mission.oeil_earning, mission.id]);
        console.log(`✅ Auto-validé mission ${mission.id}`);
      }
    } catch (e) { console.error('❌ Cron error:', e.message); }
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
