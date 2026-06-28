// ── Permissions disponibles ───────────────────────────────
const ALL_PERMISSIONS = [
  'finance', 'claims', 'moderation', 'identity',
  'users', 'missions', 'settings', 'dash', 'stats', 'audit'
];

// ── Profils prédéfinis ────────────────────────────────────
const PROFILES = {
  financier:      ['finance', 'claims', 'stats', 'dash'],
  moderation:     ['moderation', 'identity', 'claims', 'dash'],
  gestion:        ['users', 'missions', 'identity', 'dash'],
  technique:      ['settings', 'stats', 'audit', 'dash'],
  admin_complet:  ['finance', 'claims', 'moderation', 'identity', 'users', 'missions', 'settings', 'dash', 'stats'],
};

// ── Middleware requirePermission ──────────────────────────
const requirePermission = (permission) => (req, res, next) => {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'Non authentifié' });

  // Super admin → accès total
  if (user.is_super_admin) return next();

  // Admin avec la permission requise
  if (user.role === 'admin') {
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    if (perms.includes(permission)) return next();
  }

  return res.status(403).json({ error: 'Accès refusé — permission insuffisante' });
};

// ── Middleware requireSuperAdmin ──────────────────────────
const requireSuperAdmin = (req, res, next) => {
  if (!req.user?.is_super_admin) {
    return res.status(403).json({ error: 'Accès réservé au Super Admin' });
  }
  next();
};

module.exports = { requirePermission, requireSuperAdmin, ALL_PERMISSIONS, PROFILES };