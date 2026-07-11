const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/schema');
const { authenticate } = require('../middleware/auth');
const { requireSuperAdmin, ALL_PERMISSIONS, PROFILES } = require('../middleware/permissions');
const asyncHandler = require('../middleware/asyncHandler');

// ── GET /super-admin/admins — liste des admins ────────────
router.get('/admins', authenticate, requireSuperAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, email, phone, is_active, is_super_admin, permissions, created_at
     FROM users WHERE role='admin' ORDER BY created_at DESC`
  );
  res.json({ admins: rows });
}));

// ── POST /super-admin/admins — créer un admin ─────────────
router.post('/admins', authenticate, requireSuperAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  const { first_name, last_name, email, password, phone, profile, permissions } = req.body;

  if (!first_name || !last_name || !email || !password)
    return res.status(400).json({ error: 'Prénom, nom, email et mot de passe requis' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Mot de passe minimum 8 caractères' });

  // Vérifier email unique
  const { rows: [existing] } = await db.query('SELECT id FROM users WHERE email=$1', [email]);
  if (existing) return res.status(400).json({ error: 'Email déjà utilisé' });

  // Permissions : profil prédéfini ou personnalisées
  let finalPermissions = [];
  if (profile && PROFILES[profile]) {
    finalPermissions = PROFILES[profile];
  } else if (Array.isArray(permissions)) {
    finalPermissions = permissions.filter(p => ALL_PERMISSIONS.includes(p));
  }

  const hash = bcrypt.hashSync(password, 12);
  const { rows: [admin] } = await db.query(
    `INSERT INTO users (id, first_name, last_name, email, password, role, phone, permissions, is_active)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'admin', $5, $6, true) RETURNING id, first_name, last_name, email, permissions`,
    [first_name, last_name, email, hash, phone || null, JSON.stringify(finalPermissions)]
  );

  res.status(201).json({ admin });
}));

// ── PUT /super-admin/admins/:id — modifier permissions ────
router.put('/admins/:id', authenticate, requireSuperAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  const { profile, permissions, is_active } = req.body;

  let finalPermissions = null;
  if (profile && PROFILES[profile]) {
    finalPermissions = PROFILES[profile];
  } else if (Array.isArray(permissions)) {
    finalPermissions = permissions.filter(p => ALL_PERMISSIONS.includes(p));
  }

  const { rows: [admin] } = await db.query(
    `UPDATE users SET
      permissions = COALESCE($1, permissions),
      is_active   = COALESCE($2, is_active),
      updated_at  = NOW()
     WHERE id=$3 AND role='admin' RETURNING id, first_name, last_name, email, permissions, is_active`,
    [finalPermissions ? JSON.stringify(finalPermissions) : null, is_active ?? null, req.params.id]
  );

  if (!admin) return res.status(404).json({ error: 'Admin introuvable' });
  res.json({ admin });
}));

// ── DELETE /super-admin/admins/:id — supprimer un admin ───
router.delete('/admins/:id', authenticate, requireSuperAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  await db.query(`DELETE FROM users WHERE id=$1 AND role='admin' AND is_super_admin=false`, [req.params.id]);
  res.json({ message: 'Admin supprimé' });
}));

// ── GET /super-admin/permissions — liste des permissions ──
router.get('/permissions', authenticate, requireSuperAdmin, (req, res) => {
  res.json({ permissions: ALL_PERMISSIONS, profiles: PROFILES });
});


// ── POST /super-admin/test-reliability/:oeilId — TEST UNIQUEMENT, désactivé en production ──
router.post('/test-reliability/:oeilId', authenticate, requireSuperAdmin, asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Cet outil de simulation est désactivé en production.' });
  }
  const db = getDb();
  const { logReliabilityEvent } = require('../utils/reliabilityScore');
  const oeilId = req.params.oeilId;
  const { rows: [oeil] } = await db.query('SELECT * FROM users WHERE id=$1 AND role=\'oeil\'', [oeilId]);
  if (!oeil) return res.status(404).json({ error: 'Œil introuvable' });
  // Nettoyer l'historique existant
  await db.query('DELETE FROM reliability_events WHERE oeil_id=$1', [oeilId]);
  await db.query('UPDATE users SET is_suspended=false, suspended_at=NULL, suspended_reason=NULL WHERE id=$1', [oeilId]);
  const scenarios = [
    ...Array(10).fill().map((_, i) => ({ points: 10, reason: `Mission honorée parfaitement #${i + 1}`, grave: false })),
    ...Array(5).fill().map((_, i) => ({ points: 5, reason: `Mission avec souci mineur #${i + 1}`, grave: false })),
    ...Array(3).fill().map((_, i) => ({ points: 0, reason: `Mission mal notée par le client #${i + 1}`, grave: true })),
    ...Array(2).fill().map((_, i) => ({ points: 5, reason: `Transfert avant démarrage avec remplaçant #${i + 1}`, grave: false })),
    { points: -10, reason: 'Transfert avant démarrage sans remplaçant trouvé', grave: true },
    ...Array(2).fill().map((_, i) => ({ points: -70, reason: `Transfert pendant mission sans remplaçant #${i + 1}`, grave: true })),
    { points: -20, reason: 'Mission non démarrée à l\'heure (H+30)', grave: true },
  ];

  for (const s of scenarios) {
    await logReliabilityEvent(db, oeilId, null, s.points, s.reason, s.grave);
  }

  const { rows: [updated] } = await db.query('SELECT reliability_score, is_suspended FROM users WHERE id=$1', [oeilId]);

  res.json({
    message: 'Simulation terminée',
    oeil: `${oeil.first_name} ${oeil.last_name}`,
    final_score: updated.reliability_score,
    is_suspended: updated.is_suspended,
    events_created: scenarios.length,
  });
}));

module.exports = router;