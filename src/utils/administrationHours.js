// ── Règle « administrations » (décision BOSS) ────────────────────────────────────────────────
// Une mission dont la catégorie est une administration ne peut pas commencer à l'heure limite
// (réglage administration_closing_hour, défaut 17 h, heure de Casablanca) ou plus tard, ni un
// samedi ou un dimanche. 16 h 59 est accepté, 17 h 00 est refusé.
//
// Codage : une mission est « administration » quand sa sous-catégorie (type file_attente) commence
// par « Administrations — » (constants/missionCategories.js). Les missions existantes ne sont pas
// touchées : la règle ne joue qu'à la création et quand le créneau ou la sous-catégorie change.
//
// Appelée depuis prepareMissionInsert (création et PayZone) et depuis PUT /:id, PUT /:id/admin-edit
// (modification). Côté API, le refus porte le code ADMINISTRATION_HOURS.
const { getSetting } = require('./settings');
// Heure murale de Casablanca (Intl), indépendante du fuseau du process (Render tourne en UTC).
function casaParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Casablanca',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute') };
}

const ADMIN_PREFIX = 'Administrations — ';
const DEFAULT_CLOSING_HOUR = 17;
const CODE = 'ADMINISTRATION_HOURS';

function isAdministrationSubcategory(subcategory) {
  return typeof subcategory === 'string' && subcategory.startsWith(ADMIN_PREFIX);
}

// Raison du refus pour ce créneau, ou null si autorisé. Pure (testable sans base).
function administrationSlotViolation(scheduledAt, closingHour) {
  const p = casaParts(new Date(scheduledAt));
  const weekday = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay(); // 0 = dimanche, 6 = samedi
  if (weekday === 0 || weekday === 6) return 'weekend';
  if (p.h >= closingHour) return 'after_closing';
  return null;
}

function administrationMessage(closingHour) {
  return `Les administrations sont fermées après ${closingHour} h et le week-end. Choisissez un créneau plus tôt.`;
}

// Vérifie le créneau d'une mission administrative. Renvoie null si OK, sinon { error, code }.
async function checkAdministrationSlot(db, { subcategory, scheduledAt }) {
  if (!isAdministrationSubcategory(subcategory) || !scheduledAt) return null;
  if (Number.isNaN(new Date(scheduledAt).getTime())) return null; // date invalide : rejetée ailleurs
  const closingHour = Number(await getSetting(db, 'administration_closing_hour', DEFAULT_CLOSING_HOUR));
  const reason = administrationSlotViolation(scheduledAt, closingHour);
  if (!reason) return null;
  return { error: administrationMessage(closingHour), code: CODE, reason, closingHour };
}

module.exports = {
  ADMIN_PREFIX, DEFAULT_CLOSING_HOUR, CODE,
  isAdministrationSubcategory, administrationSlotViolation, administrationMessage, checkAdministrationSlot,
};
