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

  // Un Œil suspendu doit pouvoir ouvrir un ticket de support (notamment pour
  // contester/comprendre son blocage) et suivre ses échanges avec l'admin.
  if (baseUrl === '/api/tickets') {
    if (method === 'POST' && path === '/') return true;
    if (method === 'GET'  && path === '/mine') return true;
    if (method === 'GET'  && /^\/[^/]+$/.test(path) && !path.startsWith('/admin')) return true;
    if (method === 'POST' && /^\/[^/]+\/messages$/.test(path)) return true;
    return false;
  }

  if (baseUrl === '/api/missions') {
    // GET / est toujours autorisé, y compris mode="available" : la route
    // elle-même renvoie une liste vide pour un Œil suspendu dans ce mode
    // (il ne doit pas se voir proposer de nouvelles missions, mais l'appel
    // ne doit pas échouer en 403 — voir routes/missions.js GET /).
    if (method === 'GET' && path === '/') return true;
    if (method === 'GET' && path === '/inbox') return true;
    if (method === 'GET' && /^\/[^/]+\/history$/.test(path)) return true;
    if (method === 'GET' && /^\/[^/]+$/.test(path) && !['/inbox', '/my-reports'].includes(path)) return true;
    if (method === 'POST' && /^\/[^/]+\/status$/.test(path)) return true;
    if (method === 'POST' && /^\/[^/]+\/report$/.test(path)) return true;
    if (method === 'POST' && /^\/[^/]+\/messages$/.test(path)) return true;
    if (method === 'POST' && /^\/[^/]+\/seen$/.test(path)) return true;
    if (method === 'POST' && /^\/[^/]+\/location$/.test(path)) return true;
    // Confirmer sa présence concerne une mission déjà assignée (pas une nouvelle prise de
    // mission) — même logique que /:id/status, /:id/location : un Œil suspendu doit pouvoir
    // continuer d'agir sur ce qu'il a déjà, sinon la suspension garantirait mécaniquement un
    // non-réponse et un remplacement, ce qui n'est pas le rôle de la suspension.
    if (method === 'POST' && /^\/[^/]+\/confirm-presence$/.test(path)) return true;
    return false;
  }

  return false;
}

// Routes qu'un compte BLOQUÉ (is_active=false) peut encore appeler — chantier L4 (2026-09-09).
// Même intention que isSuspendedOeilAllowed, mais pour un verrou plus dur : le strict nécessaire
// pour restaurer sa session, consulter le motif du blocage, et déposer/suivre une contestation.
// Le niveau dépend de req.user.deactivation_context (voir schema.js users.deactivation_context) :
//   - 'fraud_block' (ou NULL = blocage antérieur au chantier, traité comme le plus restrictif) :
//     canal MINIMAL — /auth/me + création/consultation d'UNE contestation. PAS de fil de tickets.
//   - 'admin_toggle' / 'noshow_strikes' (désactivation client) : canal COMPLET — idem + fil de
//     support classique (tickets), aligné sur ce dont dispose un Œil is_suspended.
// La limite "une seule contestation, jamais rouvrable" du canal minimal est appliquée dans la
// route POST /api/block-appeals elle-même, pas ici.
function isDeactivatedAccountAllowed(req) {
  const { method, path, baseUrl } = req;
  const ctx = req.user?.deactivation_context;
  const fullChannel = ctx === 'admin_toggle' || ctx === 'noshow_strikes';

  // Restauration de session : AuthContext.jsx appelle GET /api/auth/me à chaque chargement et
  // déconnecte si l'appel échoue — le bloquer empêcherait le compte de voir pourquoi il est bloqué.
  if (baseUrl === '/api/auth') {
    return method === 'GET' && path === '/me';
  }

  // Contestation du blocage — les deux canaux y ont accès (la restriction du canal minimal est
  // dans la route POST elle-même : 409 si une ligne existe déjà, quel que soit son statut).
  if (baseUrl === '/api/block-appeals') {
    if (method === 'POST' && path === '/')     return true;
    if (method === 'GET'  && path === '/mine') return true;
    return false;
  }

  // Fil de support classique — canal COMPLET uniquement (désactivation client). Mêmes routes
  // que pour un Œil is_suspended : créer un ticket, lister les siens, en lire un, y répondre.
  if (fullChannel && baseUrl === '/api/tickets') {
    if (method === 'POST' && path === '/')                    return true;
    if (method === 'GET'  && path === '/mine')                return true;
    if (method === 'GET'  && /^\/[^/]+$/.test(path) && !path.startsWith('/admin')) return true;
    if (method === 'POST' && /^\/[^/]+\/messages$/.test(path)) return true;
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
      'SELECT id, role, is_active, is_suspended, deactivation_context, city, quartier, is_super_admin, permissions, password_changed_at FROM users WHERE id=$1',
      [payload.id]
    );
    if (!user) return res.status(401).json({ error: 'Compte introuvable ou suspendu' });
    if (user.password_changed_at && payload.iat * 1000 < new Date(user.password_changed_at).getTime()) {
      return res.status(401).json({ error: 'Session expirée suite à un changement de mot de passe, veuillez vous reconnecter.' });
    }
    req.user = {
      id:             user.id,
      role:           user.role,
      city:           user.city,
      quartier:       user.quartier,
      is_super_admin: user.is_super_admin || false,
      permissions:    Array.isArray(user.permissions) ? user.permissions : [],
      is_suspended:   user.is_suspended || false,
      is_active:      user.is_active,
      deactivation_context: user.deactivation_context || null,
    };
    // Compte bloqué (is_active=false) : chantier L4 (2026-09-09). Avant : 401 sur TOUTE route,
    // sans exception (verrou total). Désormais : 403 (jamais 401 — l'intercepteur front sur 401
    // efface la session et empêcherait d'atteindre l'écran de contestation) SAUF sur la petite
    // liste blanche « comprendre + contester » (voir isDeactivatedAccountAllowed). Placé AVANT
    // la garde is_suspended : un Œil peut être is_active=false (blocage anti-fraude) — c'est le
    // verrou le plus fort, il prime.
    if (!user.is_active) {
      if (isDeactivatedAccountAllowed(req)) return next();
      return res.status(403).json({ error: 'Votre compte est bloqué.', deactivation_context: user.deactivation_context || null });
    }
    if (user.role === 'oeil' && user.is_suspended && !isSuspendedOeilAllowed(req)) {
      return res.status(403).json({ error: 'Votre compte est suspendu.' });
    }
    next();
  } catch { return res.status(401).json({ error: 'Token invalide ou expiré' }); }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) return res.status(403).json({ error: `Rôle requis: ${roles.join(' ou ')}` });
    next();
  };
}

module.exports = { authenticate, requireRole, isSuspendedOeilAllowed, isDeactivatedAccountAllowed };