const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { VALID_CATEGORIES, URGENT_CATEGORY, SURVEILLANCE_CATEGORIES } = require('../constants/ticketCategories');

async function notify(db, userId, title, body, type = 'info', missionId = null, emitToUser = null, actionType = null, titleKey = null, bodyKey = null, params = null) {
  const r = await db.query(
    `INSERT INTO notifications (user_id,title,body,type,mission_id,action_type,title_key,body_key,params) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [userId, title, body, type, missionId, actionType, titleKey, bodyKey, params ? JSON.stringify(params) : null]
  );
  if (emitToUser) emitToUser(userId, 'notification', r.rows[0]);
}

const REFERENCE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans caractères ambigus (0/O, 1/I)

function randomReference() {
  let ref = '';
  for (let i = 0; i < 6; i++) ref += REFERENCE_CHARS[Math.floor(Math.random() * REFERENCE_CHARS.length)];
  return `TKT-${ref}`;
}

async function generateUniqueReference(db) {
  for (let i = 0; i < 5; i++) {
    const ref = randomReference();
    const { rows } = await db.query('SELECT 1 FROM support_tickets WHERE reference=$1', [ref]);
    if (!rows.length) return ref;
  }
  throw new Error('Impossible de générer une référence de ticket unique');
}

// ── POST /tickets — création d'un ticket ────────────────────
router.post('/', authenticate, requireRole('client', 'oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const { category, subcategory, mission_id, initial_message } = req.body;

  if (!category || !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Catégorie invalide' });
  }
  if (!initial_message || !initial_message.trim()) {
    return res.status(400).json({ error: 'Message requis' });
  }

  let mission = null;
  if (mission_id) {
    const { rows: [m] } = await db.query('SELECT * FROM missions WHERE id=$1', [mission_id]);
    if (!m) return res.status(404).json({ error: 'Mission introuvable' });
    const owns = (req.user.role === 'client' && m.client_id === req.user.id)
      || (req.user.role === 'oeil' && m.oeil_id === req.user.id);
    if (!owns) return res.status(403).json({ error: 'Cette mission ne vous appartient pas' });
    mission = m;
  }

  const isUrgent = category === URGENT_CATEGORY;
  const reference = await generateUniqueReference(db);
  const id = uuidv4();

  const { rows: [ticket] } = await db.query(
    `INSERT INTO support_tickets
      (id, reference, user_id, user_role, category, subcategory, mission_id, initial_message, is_urgent, last_user_message_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
     RETURNING *`,
    [id, reference, req.user.id, req.user.role, category, subcategory || null, mission ? mission.id : null, initial_message.trim(), isUrgent]
  );

  await db.query(
    `INSERT INTO ticket_messages (ticket_id, sender_id, sender_role, content) VALUES ($1,$2,$3,$4)`,
    [ticket.id, req.user.id, req.user.role, initial_message.trim()]
  );

  if (mission && SURVEILLANCE_CATEGORIES.includes(category)) {
    await db.query(`UPDATE missions SET under_surveillance=true, updated_at=NOW() WHERE id=$1`, [mission.id]);
  }

  if (isUrgent) {
    const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
    for (const admin of admins) {
      await notify(
        db, admin.id,
        '🆘 TICKET URGENT — action immédiate requise',
        `${req.user.role === 'client' ? 'Client' : 'Œil'} a ouvert un ticket urgent : "${subcategory || category}" (${reference})`,
        'error', mission ? mission.id : null, emitToUser, 'admin_urgent_ticket',
        'urgentTicketAdminTitle', 'urgentTicketAdminBody',
        { reporterRole: req.user.role === 'client' ? 'Client' : 'Œil', subcategory: subcategory || category, reference }
      );
    }
    const io = req.app.get('io');
    if (io) io.to('room:admin').emit('urgent_ticket_created', { ticketId: ticket.id, reference, subcategory });
  }

  res.status(201).json({ ticket });
}));

// ── GET /tickets/mine — liste des tickets de l'utilisateur connecté ──
router.get('/mine', authenticate, requireRole('client', 'oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  const { rows } = await db.query(
    `SELECT * FROM support_tickets WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset]
  );
  const { rows: [{ n: total }] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM support_tickets WHERE user_id=$1`, [req.user.id]
  );

  res.json({ tickets: rows, total, page: +page, pages: Math.ceil(total / limit) });
}));

// ── GET /tickets/admin/all — liste admin filtrable ──
// Déclarée avant /:id pour éviter que "admin" soit interprété comme un id de ticket.
router.get('/admin/all', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { status, category, is_urgent, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  const where = [];
  const params = [];
  let p = 1;
  if (status) { where.push(`status=$${p++}`); params.push(status); }
  if (category) { where.push(`category=$${p++}`); params.push(category); }
  if (is_urgent !== undefined) { where.push(`is_urgent=$${p++}`); params.push(is_urgent === 'true'); }
  const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT t.*, u.first_name, u.last_name
     FROM support_tickets t JOIN users u ON u.id = t.user_id
     ${wc}
     ORDER BY t.is_urgent DESC, t.created_at ASC
     LIMIT $${p++} OFFSET $${p++}`,
    [...params, limit, offset]
  );
  const { rows: [{ n: total }] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM support_tickets t ${wc}`, params
  );

  res.json({ tickets: rows, total, page: +page, pages: Math.ceil(total / limit) });
}));

// ── PUT /tickets/admin/:id/status — admin change le statut manuellement ──
router.put('/admin/:id/status', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const { status } = req.body;
  if (!['open', 'in_progress', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  const isBeingResolved = ['resolved', 'dismissed'].includes(status);
  const { rows: [ticket] } = await db.query(
    `UPDATE support_tickets
     SET status=$1, updated_at=NOW(),
         resolved_by=CASE WHEN $2 THEN $3::text ELSE NULL END,
         resolved_at=CASE WHEN $2 THEN NOW() ELSE NULL END
     WHERE id=$4 RETURNING *`,
    [status, isBeingResolved, req.user.id, req.params.id]
  );
  if (!ticket) return res.status(404).json({ error: 'Ticket introuvable' });

  const statusLabel = { open: 'rouvert', in_progress: 'pris en charge', resolved: 'résolu', dismissed: 'classé sans suite' }[status];
  const titleKey = { open: 'ticketStatusOpenTitle', in_progress: 'ticketStatusInProgressTitle', resolved: 'ticketStatusResolvedTitle', dismissed: 'ticketStatusDismissedTitle' }[status];
  await notify(
    db, ticket.user_id,
    `📋 Votre ticket ${ticket.reference} a été ${statusLabel}`,
    `Le statut de votre ticket a été mis à jour par notre équipe.`,
    'info', ticket.mission_id, emitToUser, 'ticket_view',
    titleKey, 'ticketStatusDefaultBody', { reference: ticket.reference }
  );

  res.json({ ticket });
}));

// ── GET /tickets/:id — détail + fil de messages ──
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: [ticket] } = await db.query('SELECT * FROM support_tickets WHERE id=$1', [req.params.id]);
  if (!ticket) return res.status(404).json({ error: 'Ticket introuvable' });

  const isOwner = ticket.user_id === req.user.id;
  if (!isOwner && req.user.role !== 'admin') return res.status(403).json({ error: 'Accès refusé' });

  const { rows: messages } = await db.query(
    `SELECT tm.*, u.first_name||' '||u.last_name AS sender_name
     FROM ticket_messages tm JOIN users u ON u.id = tm.sender_id
     WHERE tm.ticket_id=$1 ORDER BY tm.created_at ASC`,
    [ticket.id]
  );

  await db.query(
    `UPDATE ticket_messages SET is_read=true WHERE ticket_id=$1 AND sender_id!=$2`,
    [ticket.id, req.user.id]
  );

  res.json({ ticket, messages });
}));

// ── POST /tickets/:id/messages — ajouter un message au fil ──
router.post('/:id/messages', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message requis' });

  const { rows: [ticket] } = await db.query('SELECT * FROM support_tickets WHERE id=$1', [req.params.id]);
  if (!ticket) return res.status(404).json({ error: 'Ticket introuvable' });

  const isOwner = ticket.user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Accès refusé' });

  const { rows: [message] } = await db.query(
    `INSERT INTO ticket_messages (ticket_id, sender_id, sender_role, content) VALUES ($1,$2,$3,$4) RETURNING *`,
    [ticket.id, req.user.id, req.user.role, content.trim()]
  );

  const timestampField = isAdmin ? 'last_admin_message_at' : 'last_user_message_at';
  const newStatus = (isAdmin && ticket.status === 'open') ? 'in_progress' : ticket.status;
  await db.query(
    `UPDATE support_tickets SET ${timestampField}=NOW(), status=$1, updated_at=NOW() WHERE id=$2`,
    [newStatus, ticket.id]
  );

  if (isAdmin) {
    await notify(
      db, ticket.user_id,
      `💬 Nouvelle réponse sur votre ticket ${ticket.reference}`,
      content.trim().slice(0, 140),
      'info', ticket.mission_id, emitToUser, 'ticket_view',
      'ticketNewMessageAdminReplyTitle', 'ticketNewMessageAdminReplyBody', { reference: ticket.reference }
    );
  } else {
    const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
    for (const admin of admins) {
      await notify(
        db, admin.id,
        `💬 Nouveau message sur le ticket ${ticket.reference}`,
        content.trim().slice(0, 140),
        'info', ticket.mission_id, emitToUser, 'admin_ticket_message',
        'ticketNewMessageUserReplyTitle', 'ticketNewMessageUserReplyBody', { reference: ticket.reference }
      );
    }
  }
  if (io) io.to(`ticket:${ticket.id}`).emit('ticket_new_message', { ticketId: ticket.id, message });

  res.status(201).json({ message });
}));

module.exports = router;
