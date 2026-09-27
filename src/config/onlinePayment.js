// Paiement en ligne (PayZone) — interrupteur serveur (2026-09-27, décision BOSS).
//
// Variable d'environnement ONLINE_PAYMENT_ENABLED : 'true' → actif ; absente ou toute autre
// valeur → DÉSACTIVÉ (défaut sûr : PayZone n'a pas de clés de production).
// Désactivé : POST /payments/payzone/init, POST /payments/payzone/retry/:id et
// GET /payments/payzone/failed-attempts répondent 403 { code: 'ONLINE_PAYMENT_DISABLED' }
// (routes/payments.js). Le callback PayZone reste ouvert : une transaction déjà lancée doit
// pouvoir se terminer. GET /payzone/status reste ouvert (lecture de l'écran de retour).
//
// ⚠️ DEUX réglages à basculer ENSEMBLE le jour de la réactivation :
//   - backend  : ONLINE_PAYMENT_ENABLED=true (variables d'environnement Render) ;
//   - frontend : payzone { enabled: true } dans shoofly-react/src/constants/paymentMethods.js
//                (ONLINE_PAYMENT_ENABLED côté frontend : formulaire de mission, menu client).
// Lue à chaque appel (pas mise en cache) : même comportement qu'une lecture au démarrage en
// production, et testable sans recharger le module.
function isOnlinePaymentEnabled() {
  return process.env.ONLINE_PAYMENT_ENABLED === 'true';
}

// Middleware à placer APRÈS authenticate/requireRole (un appel sans jeton reste un 401).
function requireOnlinePayment(req, res, next) {
  if (isOnlinePaymentEnabled()) return next();
  return res.status(403).json({ code: 'ONLINE_PAYMENT_DISABLED', error: 'Le paiement en ligne est désactivé.' });
}

module.exports = { isOnlinePaymentEnabled, requireOnlinePayment };
