const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');

function isWithinSchedule(disponibilites) {
  if (!disponibilites) return false;
  const d = typeof disponibilites === 'string' ? JSON.parse(disponibilites) : disponibilites;
  if (!Array.isArray(d)) return false;
  const now = new Date();
  const jourIdx = now.getDay(); // 0=Dim, 1=Lun...
  const map = { 0:'Dim', 1:'Lun', 2:'Mar', 3:'Mer', 4:'Jeu', 5:'Ven', 6:'Sam' };
  const aujourdhui = d.find(x => x.jour === map[jourIdx]);
  if (!aujourdhui?.actif) return false;
  const [hd, md] = aujourdhui.debut.split(':').map(Number);
  const [hf, mf] = aujourdhui.fin.split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= hd * 60 + md && mins <= hf * 60 + mf;
}



// ── Oeils publics ──────────────────────────────────────────
router.get('/oeils', authenticate, async (req, res) => {
  const db = getDb();
  const { city, available, search } = req.query;
  let where = ["u.role='oeil'", "p.is_verified=true"], params = [], p = 1;
  if (city)          { where.push(`u.city ILIKE $${p++}`); params.push(`%${city}%`); }
  if (search) { where.push(`(u.first_name ILIKE $${p} OR u.last_name ILIKE $${p} OR u.city ILIKE $${p})`); params.push(`%${search}%`); p++; }
  if (available==='1') { where.push('p.is_available=true'); }
  const { rows } = await db.query(`
    SELECT u.id,u.first_name,u.last_name,u.city,u.avatar_url,u.disponibilites,
  p.bio,p.coverage_zone,p.is_verified,p.is_available,p.rating_avg,p.rating_count,p.total_missions
FROM users u JOIN oeil_profiles p ON p.user_id=u.id

    WHERE ${where.join(' AND ')} ORDER BY p.rating_avg DESC, p.total_missions DESC
  `, params);
  const oeils = rows.map(o => ({
  ...o,
  is_available: o.is_available && isWithinSchedule(o.disponibilites)
}))
res.json({ oeils });
});

router.get('/oeils/:id', authenticate, async (req, res) => {
  const db = getDb();
  const { rows: [oeil] } = await db.query(`
    SELECT u.id,u.first_name,u.last_name,u.city,u.avatar_url,u.created_at,p.*
    FROM users u JOIN oeil_profiles p ON p.user_id=u.id WHERE u.id=$1 AND u.role='oeil'
  `, [req.params.id]);
  if (!oeil) return res.status(404).json({ error: 'Introuvable' });
  const { rows: reviews } = await db.query(`
    SELECT r.score,r.comment,r.created_at,c.first_name AS client_name
    FROM ratings r JOIN users c ON c.id=r.client_id WHERE r.oeil_id=$1 ORDER BY r.created_at DESC LIMIT 10
  `, [req.params.id]);
  res.json({ oeil, reviews });
});

// ── Notifications ──────────────────────────────────────────
router.get('/notifications', authenticate, async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND is_read=false`, [req.user.id]);
  res.json({ notifications: rows, unread: n });
});

router.put('/notifications/read', authenticate, async (req, res) => {
  const db = getDb();
  const { ids } = req.body;
  if (ids?.length) {
    await db.query(`UPDATE notifications SET is_read=true WHERE user_id=$1 AND id=ANY($2)`, [req.user.id, ids]);
  } else {
    await db.query(`UPDATE notifications SET is_read=true WHERE user_id=$1`, [req.user.id]);
  }
  res.json({ message: 'Lu' });
});

// ── Oeil: disponibilités ───────────────────────────────────
router.get('/oeil/availability', authenticate, requireRole('oeil'), async (req, res) => {
  const db = getDb();
  const { rows } = await db.query('SELECT * FROM oeil_availability WHERE user_id=$1 ORDER BY day_of_week', [req.user.id]);
  res.json({ availability: rows });
});

router.put('/oeil/availability', authenticate, requireRole('oeil'), async (req, res) => {
  const db = getDb();
  const { slots } = req.body;
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots requis' });
  await db.query('DELETE FROM oeil_availability WHERE user_id=$1', [req.user.id]);
  for (const s of slots) {
    await db.query('INSERT INTO oeil_availability (user_id,day_of_week,start_time,end_time,is_active) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, s.day_of_week, s.start_time, s.end_time, s.is_active !== false]);
  }
  res.json({ message: 'Disponibilités mises à jour' });
});

router.put('/oeil/toggle-available', authenticate, requireRole('oeil'), async (req, res) => {
  const db = getDb();
  const { rows: [p] } = await db.query('SELECT is_available FROM oeil_profiles WHERE user_id=$1', [req.user.id]);
  const { rows: [u] } = await db.query('UPDATE oeil_profiles SET is_available=$1 WHERE user_id=$2 RETURNING is_available', [!p.is_available, req.user.id]);
  res.json({ is_available: u.is_available });
});

// ── Favoris ────────────────────────────────────────────────
router.get('/favorites', authenticate, requireRole('client'), async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`
    SELECT u.id,u.first_name,u.last_name,u.city,p.rating_avg,p.total_missions,p.is_available
    FROM favorites f JOIN users u ON u.id=f.oeil_id JOIN oeil_profiles p ON p.user_id=u.id
    WHERE f.client_id=$1 ORDER BY f.created_at DESC
  `, [req.user.id]);
  res.json({ favorites: rows });
});

router.post('/favorites/:oeilId', authenticate, requireRole('client'), async (req, res) => {
  const db = getDb();
  await db.query('INSERT INTO favorites (client_id,oeil_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.params.oeilId]);
  res.status(201).json({ message: 'Ajouté aux favoris' });
});

router.delete('/favorites/:oeilId', authenticate, requireRole('client'), async (req, res) => {
  const db = getDb();
  await db.query('DELETE FROM favorites WHERE client_id=$1 AND oeil_id=$2', [req.user.id, req.params.oeilId]);
  res.json({ message: 'Retiré des favoris' });
});

// ── Oeil: virement ─────────────────────────────────────────
router.post('/oeil/withdraw', authenticate, requireRole('oeil'), async (req, res) => {
  const db = getDb();
  const { amount, bank_info } = req.body;
  if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum 100 MAD' });
  const { rows: [p] } = await db.query('SELECT balance FROM oeil_profiles WHERE user_id=$1', [req.user.id]);
  if (!p || p.balance < amount) return res.status(400).json({ error: 'Solde insuffisant' });
  await db.query('UPDATE oeil_profiles SET balance=balance-$1 WHERE user_id=$2', [amount, req.user.id]);
  await db.query('INSERT INTO withdrawals (oeil_id,amount,bank_info) VALUES ($1,$2,$3)', [req.user.id, amount, JSON.stringify(bank_info)]);
  res.status(201).json({ message: `Virement de ${amount} MAD soumis. Traitement sous 48h.` });
});

// ══ ADMIN ══════════════════════════════════════════════════
router.get('/admin/all', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const { role, is_active } = req.query;
  let where = [], params = [], p = 1;
  if (role)       { where.push(`u.role=$${p++}`); params.push(role); }
  if (is_active !== undefined) { where.push(`u.is_active=$${p++}`); params.push(is_active === '1'); }
  const { rows } = await db.query(`
    SELECT u.id,u.email,u.role,u.first_name,u.last_name,u.phone,u.city,u.is_active,u.created_at,
      pr.is_verified,pr.rating_avg,pr.total_missions,pr.balance
    FROM users u LEFT JOIN oeil_profiles pr ON pr.user_id=u.id
    ${where.length ? 'WHERE '+where.join(' AND ') : ''}
    ORDER BY u.created_at DESC
  `, params);
  res.json({ users: rows });
});

router.get('/admin/stats', authenticate, requireRole('admin'), async (req, res) => {
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
});

router.put('/admin/:id/verify-oeil', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  await db.query(`UPDATE oeil_profiles SET is_verified=true, id_verified_at=NOW() WHERE user_id=$1`, [req.params.id]);
  const notif = await db.query(`INSERT INTO notifications (user_id,title,body,type) VALUES ($1,'✅ Profil vérifié !','Vous pouvez maintenant accepter des missions.','info') RETURNING *`, [req.params.id]);
  if (emitToUser) emitToUser(req.params.id, 'notification', notif.rows[0]);
  res.json({ message: 'Œil vérifié' });
});

router.put('/admin/:id/toggle-active', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const { rows: [u] } = await db.query(`UPDATE users SET is_active = NOT is_active WHERE id=$1 RETURNING is_active`, [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Introuvable' });
  res.json({ is_active: u.is_active });
});

router.get('/admin/withdrawals', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`
    SELECT w.*, u.first_name||' '||u.last_name AS oeil_name, u.phone AS oeil_phone
    FROM withdrawals w JOIN users u ON u.id=w.oeil_id ORDER BY w.created_at DESC
  `);
  res.json({ withdrawals: rows });
});

router.put('/admin/withdrawals/:id', authenticate, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const { status } = req.body;
  if (!['approved','paid','rejected'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  const { rows: [w] } = await db.query('SELECT * FROM withdrawals WHERE id=$1', [req.params.id]);
  if (!w) return res.status(404).json({ error: 'Introuvable' });
  await db.query(`UPDATE withdrawals SET status=$1,processed_by=$2,processed_at=NOW() WHERE id=$3`, [status, req.user.id, req.params.id]);
  if (status === 'rejected') {
    await db.query('UPDATE oeil_profiles SET balance=balance+$1 WHERE user_id=$2', [w.amount, w.oeil_id]);
    const n = await db.query(`INSERT INTO notifications (user_id,title,body,type) VALUES ($1,'Virement refusé','Votre demande a été refusée. Solde recrédité.','info') RETURNING *`, [w.oeil_id]);
    if (emitToUser) emitToUser(w.oeil_id, 'notification', n.rows[0]);
  }
  if (status === 'paid') {
    const n = await db.query(`INSERT INTO notifications (user_id,title,body,type) VALUES ($1,'💸 Virement effectué',$2,'info') RETURNING *`, [w.oeil_id, `${w.amount} MAD virés sur votre compte.`]);
    if (emitToUser) emitToUser(w.oeil_id, 'notification', n.rows[0]);
  }
  res.json({ message: `Virement ${status}` });
});

// Admin joins its own WS room on connect (done client-side)
module.exports = router;
