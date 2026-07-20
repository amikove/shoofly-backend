// Intégration PayZone (paiement client réel, sandbox pour l'instant — voir .env).
//
// Deux signatures distinctes, ne pas les confondre :
//  - signOutgoing : SHA256 simple (PAS de HMAC) = secretKey concaténée brute devant le JSON
//    stringifié du payload, exigé par PayZone pour le lancement du paywall (payload sortant).
//  - verifyCallbackSignature : HMAC-SHA256(corps_brut, notificationKey), pour authentifier
//    le webhook entrant de PayZone. Comparaison en temps constant (timingSafeEqual) — une
//    comparaison de string classique fuiterait la position du premier octet différent.
const crypto = require('crypto');

function signOutgoing(payloadString) {
  return crypto.createHash('sha256').update(process.env.PAYZONE_SECRET_KEY + payloadString).digest('hex');
}

// customerId doit être l'id utilisateur réel Shoofly (unique par client, stable) — jamais
// un timestamp ou une valeur générée à la volée (fragile, cf. exemple PayZone fourni).
// chargeId/orderId = id de la tentative mission_payment_attempts (unique par tentative).
function buildPaywallPayload({ customerId, chargeId, price, description, customerLocale = 'fr_FR' }) {
  const payload = {
    merchantAccount: process.env.PAYZONE_MERCHANT_ACCOUNT,
    timestamp: Math.floor(Date.now() / 1000),
    skin: 'vps-1-vue',
    customerId: String(customerId),
    customerCountry: 'MA',
    customerLocale,
    chargeId: String(chargeId),
    orderId: String(chargeId),
    price: Number(price).toFixed(2),
    currency: 'MAD',
    description: String(description).slice(0, 200),
    mode: 'DEEP_LINK',
    paymentMethod: 'CREDIT_CARD',
    showPaymentProfiles: 'false',
    callbackUrl: `${process.env.BACKEND_URL}/api/payments/payzone/callback`,
    successUrl: `${process.env.FRONTEND_URL}/payment/return?attemptId=${chargeId}&result=success`,
    failureUrl: `${process.env.FRONTEND_URL}/payment/return?attemptId=${chargeId}&result=failure`,
    cancelUrl: `${process.env.FRONTEND_URL}/payment/return?attemptId=${chargeId}&result=cancel`,
  };
  const payloadString = JSON.stringify(payload);
  const signature = signOutgoing(payloadString);
  return { payload, payloadString, signature };
}

// rawBody DOIT être le Buffer/string exact reçu sur le fil (voir express.raw() scopé à
// cette route dans index.js) — jamais un body re-sérialisé après JSON.parse, sinon la
// signature ne correspondra pas à ce que PayZone a réellement signé (ou pire, deviendrait
// falsifiable si on recalculait sur une forme normalisée par nos soins).
function verifyCallbackSignature(rawBody, signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  const expectedHex = crypto.createHmac('sha256', process.env.PAYZONE_NOTIFICATION_KEY).update(rawBody).digest('hex');

  const expected = Buffer.from(expectedHex, 'hex');
  let provided;
  try {
    provided = Buffer.from(signatureHeader, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

module.exports = { signOutgoing, buildPaywallPayload, verifyCallbackSignature };
