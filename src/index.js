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
const authRoutes    = require('./routes/auth');
const fraudRoutes   = require('./routes/antiFraud');
const missionRoutes = require('./routes/missions');
const mediaRoutes   = require('./routes/media');
const userRoutes    = require('./routes/users');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || '*', credentials: true }
});

// ── Expose io to routes ───────────────────────────────────
app.set('io', io);

// ── Security & middleware ─────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: function(origin, callback) {
    const allowed = [
      'https://shoofly.netlify.app',
      'http://localhost:5173',
      'http://localhost:3000',
      'http://localhost',
    ];
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS bloqué: ' + origin));
    }
  },
  credentials: true,
}));
app.use(rateLimit({ windowMs: 15*60*1000, max: 300, skip: (req) => req.path === '/health' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(path.resolve(process.env.UPLOAD_DIR || './uploads')));

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/missions', missionRoutes);
app.use('/api/media',    mediaRoutes);
app.use('/api/users',    userRoutes);
app.use('/api/anti-fraud', fraudRoutes);

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api', (_, res) => res.json({ name: 'SHOOFLY API', version: '1.0.0' }));
app.use((req, res) => res.status(404).json({ error: `Route introuvable: ${req.method} ${req.path}` }));
app.use((err, req, res, next) => {
  console.error('❌', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Fichier trop volumineux' });
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Erreur serveur' : err.message });
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
  if (sockets) sockets.forEach(sid => io.to(sid).emit(event, data));
});

// ── Start ─────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;

initDb().then(() => {
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
