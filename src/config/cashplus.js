// Recharge du wallet Œil par CashPlus — interrupteur serveur (chantier CashPlus 2026-09-27,
// décision BOSS, point 5).
//
// Variable d'environnement CASHPLUS_ENABLED : 'true' → active ; absente ou toute autre valeur →
// DÉSACTIVÉE (défaut sûr : l'appel generate-token échoue en 502 tant que l'accès CashPlus n'est pas
// opérationnel).
// Désactivée :
//   - POST /users/oeil/cashplus/generate-token répond 403 { code: 'CASHPLUS_DISABLED' } ;
//   - GET /users/oeil/earnings renvoie cashplus_enabled: false → le frontend masque le bouton
//     « Recharger » (page Gains).
// Le CALLBACK CashPlus (POST /payments/cashplus/callback) reste OUVERT : un paiement déjà lancé en
// agence doit toujours créditer le wallet.
// Lue à chaque appel (pas mise en cache) : même principe que config/onlinePayment.js.
function isCashPlusEnabled() {
  return process.env.CASHPLUS_ENABLED === 'true';
}

// Middleware à placer APRÈS authenticate/requireRole (un appel sans jeton reste un 401).
function requireCashPlusEnabled(req, res, next) {
  if (isCashPlusEnabled()) return next();
  return res.status(403).json({ code: 'CASHPLUS_DISABLED', error: 'La recharge CashPlus est désactivée.' });
}

module.exports = { isCashPlusEnabled, requireCashPlusEnabled };
