// ── Téléphone : normalisation E.164 d'un mobile marocain (décision BOSS D1, 2026-09-28) ──
// Seul format stocké pour un numéro saisi à l'inscription / à la modification : +2126XXXXXXXX ou
// +2127XXXXXXXX. Formes acceptées en entrée (espaces, points, tirets, parenthèses, barres ignorés) :
//   06XXXXXXXX / 07XXXXXXXX · 6XXXXXXXX / 7XXXXXXXX · +2126… / +2127… · 002126… · 2126… (12 chiffres)
//   · +212 06… (0 superflu après l'indicatif).
// Tout le reste (fixe 05…, numéro étranger, texte) → null = invalide.
//
// JUMELLE SQL : la fonction shoofly_phone_e164(text) (db/schema.js) applique EXACTEMENT la même
// règle — elle porte l'index unique uq_users_phone_e164 et la recherche de doublon, pour que les
// numéros déjà en base, stockés dans d'anciens formats, soient comparés sous leur forme normalisée.
// Toute modification ici doit être reportée là-bas (test : _audit/e2e/fmf/phone_test.js).
function normalizeMoroccanMobile(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/[\s.()/-]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('+212')) s = s.slice(4);
  else if (s.startsWith('212') && s.length === 12) s = s.slice(3);
  if (/^0[67]\d{8}$/.test(s)) return '+212' + s.slice(1);
  if (/^[67]\d{8}$/.test(s)) return '+212' + s;
  return null;
}

const PHONE_INVALID_MESSAGE = 'Numéro de téléphone invalide : saisissez un numéro mobile marocain (06… / 07… ou +2126… / +2127…).';
const PHONE_REQUIRED_MESSAGE = 'Le numéro de téléphone est obligatoire pour un compte Œil.';
const PHONE_TAKEN_MESSAGE = 'Numéro de téléphone déjà utilisé';

// Champ téléphone « renseigné » ? (chaîne vide / espaces = non renseigné, comme avant)
const phoneProvided = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// Violation de l'index unique sur le numéro normalisé (course entre deux inscriptions).
const isPhoneUniqueViolation = (e) => e && e.code === '23505' && e.constraint === 'uq_users_phone_e164';

module.exports = {
  normalizeMoroccanMobile, phoneProvided, isPhoneUniqueViolation,
  PHONE_INVALID_MESSAGE, PHONE_REQUIRED_MESSAGE, PHONE_TAKEN_MESSAGE,
};
