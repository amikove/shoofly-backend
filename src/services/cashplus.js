// Intégration CashPlus (recharge wallet Œil en cash via agence) — voir
// RECAP_INTEGRATION_CASHPLUS.md pour les décisions métier tranchées. Doc CashPlus fournie par
// le prestataire (résumé, pas la doc complète) : endpoint ColdFusion classique
// (index.cfm?endpoint=/generate_token) — d'où le format de date "yyyy-mm-dd HH:nn:ss" (masque
// ColdFusion, nn=minutes) plutôt qu'ISO 8601, et l'hypothèse form-urlencoded ci-dessous (une
// gateway index.cfm de ce type lit typiquement le scope FORM ; le champ optionnel "json_data"
// documenté séparément — une valeur JSON encapsulée dans UN champ plat — renforce cette lecture :
// si la requête entière était déjà du JSON, ce champ n'aurait pas besoin d'exister à part).
// Point resté ambigu après lecture du seul résumé fourni, signalé dans le rapport de session :
// confirmer ce point contre la doc complète ou un premier test réel en sandbox avant prod.
const crypto = require('crypto');

const GENERATE_TOKEN_PATH = '/cpws/cpmarchand/index.cfm?endpoint=/generate_token';

// Montants de recharge autorisés — RECAP §3, pas de montant libre. Validée côté serveur avant
// tout appel CashPlus (routes/users.js) : jamais de confiance dans un montant envoyé tel quel
// par le client, même principe que toutes les validations serveur déjà en place sur ce projet.
const ALLOWED_AMOUNTS = [100, 200, 300, 500];

// fees = 3,3% TTC + 3,3 MAD TTC du montant, à la charge de l'Œil (RECAP §3, contrat CashPlus).
// Arrondi 2 décimales — seule précision disponible côté doc résumée ("probablement" 2
// décimales, non confirmé contre un test réel — voir RECAP §3 et le rapport de session).
function computeFees(amount) {
  return Math.round((Number(amount) * 0.033 + 3.3) * 100) / 100;
}

// Formate en "yyyy-mm-dd HH:nn:ss" (masque ColdFusion — HH=24h, nn=minutes), heure
// Africa/Casablanca — même convention horaire que le reste du projet (index.js, tous les
// cron.schedule ; utils/schedule.js). La doc résumée ne précise aucun fuseau pour ce champ ;
// hypothèse alignée sur l'exploitation réelle (Maroc) plutôt que sur l'horloge UTC du serveur,
// à vérifier si CashPlus attend explicitement autre chose.
function formatCashPlusDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Casablanca',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

// hmac = UPPERCASE(SHA256(marchand_code + secret_key + amount)) — concaténation brute sans
// séparateur, exactement comme spécifié. `amount` est ici représenté avec 2 décimales
// (toFixed(2)) — la doc résumée ne précise pas explicitement le format numérique attendu DANS
// le HMAC (entier "100" vs "100.00"), donc ce choix garantit au moins la cohérence interne avec
// la valeur réellement envoyée dans le champ `amount` du payload (callGenerateToken ci-dessous,
// même représentation des deux côtés) — signalé comme hypothèse à vérifier dans le rapport de
// session, voir aussi RECAP §1.
function signGenerateToken(amount) {
  const marchandCode = process.env.CASHPLUS_MARCHAND_CODE;
  const secretKey = process.env.CASHPLUS_SECRET_KEY;
  const raw = `${marchandCode}${secretKey}${Number(amount).toFixed(2)}`;
  return crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
}

// hmac callback = UPPERCASE(SHA256(request_id + secret_key)) — vérifié AVANT tout traitement
// (routes/payments.js). Comparaison en temps constant (timingSafeEqual) — même précaution que
// verifyCallbackSignature (services/payzone.js), même si la surface d'attaque diffère ici (HMAC
// transmis en clair DANS le payload plutôt que dans un header séparé sur le corps brut — CashPlus
// n'utilise pas ce schéma d'après la doc résumée fournie). Propriété notable de ce schéma,
// signalée dans le rapport de session : le HMAC callback ne porte que sur request_id+secret_key,
// jamais sur amount — l'amount du payload callback n'est donc PAS authentifié par le HMAC, ce
// qui est précisément pourquoi routes/payments.js ne crédite jamais ce montant-là, uniquement
// celui stocké en base à la génération (voir prompt, section "Garde-fous").
function verifyCallbackHmac(requestId, receivedHmac) {
  if (!requestId || !receivedHmac || typeof receivedHmac !== 'string') return false;
  const secretKey = process.env.CASHPLUS_SECRET_KEY;
  const expectedHex = crypto.createHash('sha256').update(`${requestId}${secretKey}`).digest('hex').toUpperCase();

  const expected = Buffer.from(expectedHex, 'utf8');
  const provided = Buffer.from(String(receivedHmac).toUpperCase(), 'utf8');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

// Appelle CashPlus generate_token. Ne lance jamais d'erreur réseau vers l'appelant — renvoie
// {ok:false, message} pour que la route réponde proprement (routes/users.js), même contrat que
// sendWhatsAppTemplateRaw (services/wasel.js). Encodage form-urlencoded — voir note d'en-tête de
// fichier sur cette hypothèse.
async function callGenerateToken({ requestId, amount, fees, dateExpiration }) {
  const baseUrl = process.env.CASHPLUS_API_BASE_URL;
  const marchandCode = process.env.CASHPLUS_MARCHAND_CODE;
  const secretKey = process.env.CASHPLUS_SECRET_KEY;
  if (!baseUrl || !marchandCode || !secretKey) {
    console.warn('[cashplus] Configuration manquante (CASHPLUS_API_BASE_URL/CASHPLUS_MARCHAND_CODE/CASHPLUS_SECRET_KEY) — appel ignoré');
    return { ok: false, message: 'CashPlus non configuré' };
  }

  const hmac = signGenerateToken(amount);
  const body = new URLSearchParams({
    request_id: requestId,
    amount: Number(amount).toFixed(2),
    fees: Number(fees).toFixed(2),
    marchand_code: marchandCode,
    hmac,
    date_expiration: formatCashPlusDate(dateExpiration),
  });

  try {
    const response = await fetch(`${baseUrl}${GENERATE_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await response.json().catch(() => null);
    if (!data) return { ok: false, message: `Réponse CashPlus illisible (HTTP ${response.status})` };
    if (Number(data.SUCCESS) === 1) {
      return { ok: true, token: data.TOKEN, dateExpiration: data.DATE_EXPIRATION };
    }
    return { ok: false, message: data.MESSAGE || `Échec CashPlus (HTTP ${response.status})` };
  } catch (err) {
    console.error('[cashplus] Erreur réseau generate_token:', err.message);
    return { ok: false, message: 'Erreur réseau CashPlus' };
  }
}

module.exports = {
  ALLOWED_AMOUNTS, computeFees, formatCashPlusDate,
  signGenerateToken, verifyCallbackHmac, callGenerateToken,
};
