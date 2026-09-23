// Traductions notif.* pour le SEUL canal push (notify.js) — copie du sous-ensemble de notif.*
// (shoofly-react/src/i18n/locales/{fr,ar}.json) réellement utilisé comme titleKey/bodyKey par les
// appels notify() de ce backend (option B, chantier langue des notifications push, 2026-09-23 —
// voir rapport-chantier-audit-langue-push-notifications-2026-09-23.md pour le choix A/B). Copie
// délibérée, pas de lien live avec le frontend : `npm run check:notif-i18n` (package.json)
// détecte la dérive (clés manquantes d'un côté, textes qui diffèrent) sans la corriger seul.
// Générée initialement par _audit/e2e/generate_backend_notif_copies.js (jetable, non versionné).
const fr = require('./notif.fr.json');
const ar = require('./notif.ar.json');

const CATALOGS = { fr, ar };

// Interpolation {{var}} minimale, même syntaxe que i18next côté frontend (interpolation :
// { escapeValue: false }, voir shoofly-react/src/i18n/config.js) — c'est la SEULE fonctionnalité
// i18next dont ces clés ont besoin, pas de raison d'embarquer la dépendance côté serveur pour ça.
// Un placeholder sans valeur correspondante dans `params` est laissé tel quel (jamais une chaîne
// vide silencieuse) : plus facile à repérer qu'un texte de notification tronqué sans explication.
function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  ));
}

// Renvoie le texte traduit, ou `undefined` si `lang`/`key` est absent, si la clé n'existe pas dans
// le catalogue, OU si le résultat contient encore un `{{` après interpolation (chantier langue des
// notifications push, revue BOSS 2026-09-23) — un placeholder non résolu dans un push serait pire
// que le repli FR (texte visiblement cassé plutôt qu'un français correct) : mieux vaut le repli.
// Dans tous ces cas, à l'appelant (notify.js) de décider du repli (texte FR codé en dur passé à
// notify(), comportement strictement inchangé pour tout le reste).
function t(key, lang, params) {
  if (!key || !lang) return undefined;
  const catalog = CATALOGS[lang];
  if (!catalog) return undefined;
  const template = catalog[key];
  if (template === undefined) return undefined;
  const resolved = interpolate(template, params);
  if (resolved.includes('{{')) return undefined;
  return resolved;
}

module.exports = { t };
