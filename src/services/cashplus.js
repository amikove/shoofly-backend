// Intégration CashPlus (recharge wallet Œil en cash via agence) — voir
// RECAP_INTEGRATION_CASHPLUS.md pour les décisions métier tranchées. Doc CashPlus fournie par
// le prestataire (résumé, pas la doc complète) : endpoint ColdFusion classique. Format d'URL
// CORRIGÉ le 2026-08-04 contre un exemple concret fourni par CashPlus : le endpoint est un
// segment de chemin après index.cfm (index.cfm/generate_token), PAS un paramètre de requête
// (index.cfm?endpoint=/generate_token) comme le résumé initial le laissait supposer. Le format
// de date "yyyy-mm-dd HH:nn:ss" (masque ColdFusion, nn=minutes) plutôt qu'ISO 8601, et
// l'hypothèse form-urlencoded ci-dessous restent des hypothèses non contredites par cet exemple
// (une gateway index.cfm de ce type lit typiquement le scope FORM ; le champ optionnel
// "json_data" documenté séparément — une valeur JSON encapsulée dans UN champ plat — renforce
// cette lecture : si la requête entière était déjà du JSON, ce champ n'aurait pas besoin
// d'exister à part). Points restés ambigus après lecture du seul résumé fourni, signalés dans le
// rapport de session : confirmer contre la doc complète ou un test réel en sandbox avant prod.
const crypto = require('crypto');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

const GENERATE_TOKEN_PATH = '/cpws/cpmarchand/index.cfm/generate_token';

// Montants de recharge autorisés — RECAP §3, pas de montant libre. Validée côté serveur avant
// tout appel CashPlus (routes/users.js) : jamais de confiance dans un montant envoyé tel quel
// par le client, même principe que toutes les validations serveur déjà en place sur ce projet.
const ALLOWED_AMOUNTS = [100, 200, 300, 500];

// fees = 0, TOUJOURS — changement du 2026-08-24. CashPlus a confirmé directement que le champ
// "fees" de leur API generate_token doit être 0 pour ce compte marchand : leur système ne
// supporte pas de frais à la charge du client sur cette configuration (message d'erreur reçu
// jusque-là : "Les frais ne sont pas à la charge du client"). Décision business validée en
// conséquence : les frais sont supprimés pour l'Œil, qui paie désormais exactement le montant
// rechargé, sans supplément à l'agence. Ancienne formule (3,3% TTC + 3,3 MAD TTC, RECAP §3)
// abandonnée pour cette raison précise — pas un choix de simplification, une contrainte imposée
// par le prestataire. `amount` reste en paramètre pour ne pas casser la signature de l'appelant
// (routes/users.js) ni callGenerateToken, même s'il n'est plus utilisé dans le calcul.
function computeFees(amount) {
  return 0;
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
  // POINT 4 audit sécurité global 08-09 : sans cette garde, un secretKey undefined est coercé
  // par le template literal en la chaîne "undefined" au lieu de faire échouer la vérification —
  // fail-open sous cette misconfiguration précise plutôt que fail-closed.
  if (!secretKey) return false;
  const expectedHex = crypto.createHash('sha256').update(`${requestId}${secretKey}`).digest('hex').toUpperCase();

  const expected = Buffer.from(expectedHex, 'utf8');
  const provided = Buffer.from(String(receivedHmac).toUpperCase(), 'utf8');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

// IP fixe pour le whitelisting CashPlus (exigé par le prestataire pour l'appel generate_token) —
// proxy Fixie (FIXIE_URL, credentials inclus dans l'URL : jamais loggée, jamais codée en dur)
// routé via https-proxy-agent. C'est précisément pourquoi cet appel utilise https.request()
// plutôt que fetch() comme le reste du projet (wasel.js, email.js) : le fetch natif de Node
// (undici) ignore silencieusement l'option `agent` d'un Agent classique http.Agent/https.Agent —
// ce que produit https-proxy-agent — sans lever d'erreur ; l'appel serait alors parti en direct
// sans passer par le proxy, cassant le whitelisting sans aucun signal. Vérifié empiriquement avant
// ce choix. Si FIXIE_URL est absente (dev/local), aucun blocage du process : warning + appel
// direct, comportement historique inchangé.
let cachedProxyAgent = null;
let cachedFixieUrl = null;

function getCashplusProxyAgent() {
  const fixieUrl = process.env.FIXIE_URL;
  if (!fixieUrl) {
    console.warn('[cashplus] FIXIE_URL absente — appel generate_token en direct, sans IP fixe (whitelisting CashPlus non garanti)');
    return undefined;
  }
  if (fixieUrl !== cachedFixieUrl) {
    cachedProxyAgent = new HttpsProxyAgent(fixieUrl);
    cachedFixieUrl = fixieUrl;
  }
  return cachedProxyAgent;
}

// Filet de sécurité : ne jamais logger un message d'erreur bas niveau (échec de connexion ou
// d'authentification CONNECT auprès du proxy) qui contiendrait l'URL Fixie brute.
function sanitizeNetworkErrorMessage(message) {
  const fixieUrl = process.env.FIXIE_URL;
  if (fixieUrl && message && message.includes(fixieUrl)) {
    return message.split(fixieUrl).join('[FIXIE_URL]');
  }
  return message;
}

// POST form-urlencoded via https.request. `agent` optionnel : HttpsProxyAgent (Fixie) ou
// undefined (connexion directe, https.globalAgent — comportement historique). `servername`
// explicite requis : à travers un Agent personnalisé (HttpsProxyAgent), Node ne dérive PAS
// automatiquement le SNI/la vérification de hostname TLS depuis l'URL cible comme il le fait en
// connexion directe — il retombe sur "localhost", ce qui casse la validation du certificat CashPlus
// pour CHAQUE appel proxifié. Vérifié empiriquement (voir rapport de session) : sans cette ligne,
// le round-trip complet échoue systématiquement dès que FIXIE_URL est renseignée.
function postFormViaHttps(url, formBody, agent) {
  return new Promise((resolve, reject) => {
    const { hostname } = new URL(url);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
      },
      agent,
      servername: hostname,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(formBody);
    req.end();
  });
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
    json_data: '',
  });

  try {
    const agent = getCashplusProxyAgent();
    const { status, body: responseText } = await postFormViaHttps(
      `${baseUrl}${GENERATE_TOKEN_PATH}`, body.toString(), agent,
    );
    let data = null;
    try { data = JSON.parse(responseText); } catch { /* data reste null, traité ci-dessous */ }
    if (!data) return { ok: false, message: `Réponse CashPlus illisible (HTTP ${status})` };
    if (Number(data.SUCCESS) === 1) {
      return { ok: true, token: data.TOKEN, dateExpiration: data.DATE_EXPIRATION };
    }
    console.error(`[cashplus] Rejet — HTTP ${status} — MESSAGE=${data.MESSAGE}`);
    return { ok: false, message: data.MESSAGE || `Échec CashPlus (HTTP ${status})` };
  } catch (err) {
    console.error('[cashplus] Erreur réseau generate_token:', sanitizeNetworkErrorMessage(err.message));
    return { ok: false, message: 'Erreur réseau CashPlus' };
  }
}

module.exports = {
  ALLOWED_AMOUNTS, computeFees, formatCashPlusDate,
  signGenerateToken, verifyCallbackHmac, callGenerateToken,
};
