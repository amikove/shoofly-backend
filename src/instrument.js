// Doit être require() avant tout le reste de src/index.js (avant express/http/pg/…) : l'init
// Sentry instrumente ces modules et ne peut le faire correctement que si elle a lieu avant leur
// premier require() ailleurs dans l'app. Reste cependant APRÈS `require('dotenv').config()` dans
// index.js — SENTRY_DSN doit déjà être dans process.env au moment de l'appel à Sentry.init()
// ci-dessous pour être pris en compte en dev local (Render l'injecte directement, sans dotenv).
const Sentry = require('@sentry/node');

// Filet de sécurité supplémentaire (défense en profondeur) — voir la note détaillée sous
// `dataCollection` ci-dessous pour ce qui est déjà exclu par défaut sans ce beforeSend.
const SENSITIVE_KEY_PATTERN = /pass(word)?|secret|token|jwt|authoriz|api[_-]?key/i;
function scrubSensitiveKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      obj[key] = '[Filtered]';
    } else if (obj[key] && typeof obj[key] === 'object') {
      scrubSensitiveKeys(obj[key]);
    }
  }
  return obj;
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  // Suivi d'erreurs uniquement — pas de tracing de performance (hors périmètre de ce chantier,
  // pas de tracesSampleRate défini).

  // Sans `sendDefaultPii` ni `dataCollection` définis, le SDK ne collecte par défaut AUCUN corps
  // de requête/réponse HTTP (`dataCollection.httpBodies` vaut alors `[]` tant que
  // `sendDefaultPii` n'est pas activé — vérifié dans le code source du SDK installé,
  // node_modules/@sentry/core/build/cjs/utils/data-collection/defaultPiiToCollectionOptions.js).
  // Un mot de passe envoyé dans le body de POST /api/auth/login ou /api/auth/password
  // n'atteint donc jamais Sentry par ce chemin, sans configuration supplémentaire. Les headers/
  // cookies/query params restent eux collectés par défaut, mais avec un denylist intégré au SDK
  // qui remplace par "[Filtered]" toute valeur dont la clé contient auth/token/secret/password/
  // jwt/cookie/session/etc.
  //
  // Seule dérogation nécessaire : les VARIABLES LOCALES de la pile d'appel sont capturées par
  // défaut (`stackFrameVariables: true`) SANS aucun filtrage par nom connu (contrairement aux
  // headers/cookies/query params ci-dessus) — une variable locale nommée `password` au moment
  // d'une exception dans un handler de /login serait donc exfiltrée telle quelle. Désactivé
  // explicitement ci-dessous.
  dataCollection: {
    stackFrameVariables: false,
  },

  // Filet de sécurité supplémentaire : si un futur changement réactive un jour la capture du
  // body (dataCollection.httpBodies) sans relire la note ci-dessus, ces champs restent retirés.
  beforeSend(event) {
    if (event.request?.data) scrubSensitiveKeys(event.request.data);
    if (event.request?.cookies) scrubSensitiveKeys(event.request.cookies);
    if (event.request?.headers) scrubSensitiveKeys(event.request.headers);
    return event;
  },
});

if (process.env.SENTRY_DSN) {
  console.log(`🛰️  Sentry initialisé (backend) — environment=${process.env.NODE_ENV || 'development'}`);
} else {
  console.warn("⚠️  SENTRY_DSN non définie — suivi d'erreurs Sentry désactivé (normal en dev local sans DSN configuré ; l'app fonctionne normalement).");
}

module.exports = Sentry;
