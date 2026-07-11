const jwt = require('jsonwebtoken');
const { getDb } = require('../db/schema');

// Routes qu'un Œil suspendu peut encore appeler : consulter son score et
// demander une révision, plus le strict nécessaire pour terminer proprement
// une mission déjà en cours (il ne doit pas pouvoir en prendre de nouvelles).
// Volontairement PAS whitelisté : /:id/refuse, /:id/transfer, /:id/interest,
// /:id/accept — ce serait reprendre la main sur l'attribution de missions.
function isSuspendedOeilAllowed(req) {
  const { method, path, baseUrl } = req;

  // Le frontend appelle GET /api/auth/me à chaque chargement de page pour
  // restaurer la session, et déconnecte l'utilisateur si cet appel échoue
  // (voir AuthContext.jsx). Le bloquer déconnecterait un Œil suspendu en
  // permanence, l'empêchant précisément de voir pourquoi il est suspendu.
  if (baseUrl === '/api/auth') {
    return method === 'GET' && path === '/me';
  }

  if (baseUrl === '/api/reliability') {
    if (method === 'GET'  && path === '/me') return true;
    if (method === 'POST' && path === '/review-request') return true;
    return false;
  }

  if (baseUrl === '/api/missions') {
    // Liste de ses propres missions (hors mode="available", qui expose les
    // nouvelles missions à prendre — ça reste interdit).
    if (method === 'GET' && path === '/' && req.query.mode !== 'available') return true;
    if (method === 'GET' && path === '/inbox') return true;
    if (method === 'GET' && /^\/[^/]+\/history$/.test(path)) return true;
    if (method === 'GET' && /^\/[^/]+$/.test(path) && !['/inbox', '/my-reports'].includes(path)) return true;
    if (method === 'POST' && /^\/[^/]+\/status$/.test(path)) return true;
    if (method === 'POST' && /^\/[^/]+\/report$/.test(path)) return true;
    if (method === 'POST' && /^\/[^/]+\/messages$/.test(path)) return true;
    if (method === 'POST' && /^\/[^/]+\/seen$/.test(path)) return true;
    if (method === 'POST' && /^\/[^/]+\/location$/.test(path)) return true;
    return false;
  }

  return false;
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token manquant' });
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const { rows: [user] } = await getDb().query(
      'SELECT id, role, is_active, is_suspended, city, quartier, is_super_admin, permissions FROM users WHERE id=$1',
      [payload.id]
    );
    if (!user || !user.is_active) return res.status(401).json({ error: 'Compte introuvable ou suspendu' });
    if (user.role === 'oeil' && user.is_suspended && !isSuspendedOeilAllowed(req)) {
      return res.status(403).json({ error: 'Votre compte est suspendu.' });
    }
    req.user = {
      id:             user.id,
      role:           user.role,
      city:           user.city,
      quartier:       user.quartier,
      is_super_admin: user.is_super_admin || false,
      permissions:    Array.isArray(user.permissions) ? user.permissions : [],
    };
    next();
  } catch { return res.status(401).json({ error: 'Token invalide ou expiré' }); }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) return res.status(403).json({ error: `Rôle requis: ${roles.join(' ou ')}` });
    next();
  };
}

module.exports = { authenticate, requireRole };