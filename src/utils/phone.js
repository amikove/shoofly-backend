// ── Téléphone : normalisation E.164 (décisions BOSS D1, 2026-09-28, puis 2 ajustements le même jour
// puis le 2026-09-29 : fixe marocain refusé pour TOUS les rôles) ──
// Téléphone OBLIGATOIRE pour tout client et tout Œil ; UN numéro = UN compte ; numéro de préférence
// WhatsApp, donc MOBILE marocain uniquement (un fixe 05… ne reçoit pas de WhatsApp).
//
// normalizePhone — règle GÉNÉRALE (c'est elle que porte l'unicité) :
//   • numéro marocain : MOBILE 06… / 07… seulement (fixe 05… → null, quel que soit le rôle), écrit
//     0X…, X… (9 chiffres), +212…, 00212…, 212… (12 chiffres), avec ou sans 0 superflu après
//     l'indicatif → +212XXXXXXXXX ;
//   • numéro international : « + » (ou « 00 ») suivi de l'indicatif pays, 8 à 15 chiffres au total
//     (E.164) → +XXXXXXXX…  (ex. +33 6 12 34 56 78 → +33612345678).
//   Espaces, points, tirets, parenthèses et barres sont ignorés. Tout le reste → null : texte,
//   fixe marocain 05…, numéro étranger écrit sans « + » (ambigu), longueur hors E.164, préfixe
//   marocain inconnu.
// normalizePhoneForRole — règle par rôle : un Œil doit avoir un MOBILE MAROCAIN (+2126… / +2127…),
//   numéro étranger refusé ; client et admin : règle générale (numéro étranger accepté, mais un
//   numéro marocain doit être un mobile — le fixe est refusé pour tous les rôles).
//
// JUMELLE SQL : la fonction shoofly_phone_e164(text) (db/schema.js) applique EXACTEMENT
// normalizePhone — elle porte l'index unique uq_users_phone_e164 et la recherche de doublon, pour
// que les numéros déjà en base dans d'anciens formats soient comparés sous leur forme normalisée.
// Toute modification ici doit être reportée là-bas, ET impose un REINDEX de uq_users_phone_e164
// (test : _audit/e2e/fmf/phone_test.js, contrôle P1).
function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/[\s.()/-]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  let ma = null; // partie nationale marocaine, si le numéro est marocain (ou écrit localement)
  if (s.startsWith('+212')) ma = s.slice(4);
  else if (s.startsWith('212') && s.length === 12) ma = s.slice(3);
  else if (!s.startsWith('+')) ma = s;
  if (ma !== null) {
    if (/^0[67]\d{8}$/.test(ma)) return '+212' + ma.slice(1);
    if (/^[67]\d{8}$/.test(ma)) return '+212' + ma;
    return null; // dont un fixe marocain 05… : refusé pour tous les rôles (décision BOSS 2026-09-29)
  }
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

const isMoroccanMobile = (e164) => /^\+212[67]\d{8}$/.test(e164 || '');

function normalizePhoneForRole(input, role) {
  const e164 = normalizePhone(input);
  if (!e164) return null;
  if (role === 'oeil' && !isMoroccanMobile(e164)) return null;
  return e164;
}

const PHONE_INVALID_MESSAGES = {
  oeil: 'Numéro de téléphone invalide : un Œil doit saisir un numéro mobile marocain (06… / 07… ou +2126… / +2127…).',
  default: 'Numéro de téléphone invalide : saisissez un numéro mobile marocain (06… / 07…) ou un numéro étranger complet avec l\'indicatif du pays (ex. +33 6 12 34 56 78). Un fixe marocain (05…) n\'est pas accepté.',
};
const phoneInvalidMessage = (role) => PHONE_INVALID_MESSAGES[role] || PHONE_INVALID_MESSAGES.default;
const PHONE_REQUIRED_MESSAGE = 'Le numéro de téléphone est obligatoire.';
const PHONE_TAKEN_MESSAGE = 'Numéro de téléphone déjà utilisé';

// Champ téléphone « renseigné » ? (chaîne vide / espaces = non renseigné)
const phoneProvided = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// Violation de l'index unique sur le numéro normalisé (course entre deux inscriptions).
const isPhoneUniqueViolation = (e) => e && e.code === '23505' && e.constraint === 'uq_users_phone_e164';

module.exports = {
  normalizePhone, normalizePhoneForRole, isMoroccanMobile, phoneProvided, isPhoneUniqueViolation,
  phoneInvalidMessage, PHONE_REQUIRED_MESSAGE, PHONE_TAKEN_MESSAGE,
};
