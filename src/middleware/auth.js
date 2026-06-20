const jwt = require('jsonwebtoken');
const { getDb } = require('../db/schema');

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token manquant' });
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const { rows: [user] } = await getDb().query('SELECT id,role,is_active FROM users WHERE id=$1', [payload.id]);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Compte introuvable ou suspendu' });
    req.user = { id: user.id, role: user.role };
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
