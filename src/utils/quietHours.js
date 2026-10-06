// ── Plage de silence des notifications non urgentes (décision BOSS, 2026-10-06, point 6) ──────
// Plage 22 h – 7 h, heure de Casablanca, réglable (quiet_hours_start / quiet_hours_end). Elle ne
// concerne QUE les notifications non urgentes (voir utils/notify.js notifyDifferable). Une
// notification reçue pendant la plage est reportée à la fin de la plage, SAUF si la mission
// commence avant « fin de plage + 3 h » : dans ce cas elle part tout de suite.
//
// Ce module contient la logique PURE (testable avec une date donnée) ; le décalage de fuseau est
// calculé par Intl (Africa/Casablanca), donc correct même si le serveur tourne en UTC (Render).
const { getSetting } = require('./settings');

const EXCEPTION_LEAD_MS = 3 * 60 * 60 * 1000;

// Heure murale de Casablanca pour un instant donné.
function casaParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Casablanca',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute') };
}

// Instant UTC correspondant à « y-mo-d h:00 » heure de Casablanca (correction de décalage
// itérative : Casablanca n'a pas d'heure d'été, mais le calcul reste exact si cela change).
function casaWallToInstant(y, mo, d, h) {
  const target = Date.UTC(y, mo - 1, d, h);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = casaParts(new Date(guess));
    guess += target - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return new Date(guess);
}

// Heure (0-23) comprise dans la plage ? start = end → plage désactivée. start > end → plage qui
// passe minuit (ex. 22 → 7).
function isQuietHour(h, start, end) {
  if (start === end) return false;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

// Fin de la plage en cours (instant) si `now` tombe dedans, sinon null.
function quietWindowEnd(now, start, end) {
  if (start === end) return null;
  const p = casaParts(now);
  if (!isQuietHour(p.h, start, end)) return null;
  // Plage qui passe minuit et on est sur sa partie du soir (h >= start) : la fin est le lendemain.
  let { y, mo, d } = p;
  if (start > end && p.h >= start) {
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    y = next.getUTCFullYear(); mo = next.getUTCMonth() + 1; d = next.getUTCDate();
  }
  return casaWallToInstant(y, mo, d, end);
}

// Décision pure : instant d'envoi différé, ou null si la notification part maintenant.
function deliveryPlan(now, start, end, missionScheduledAt) {
  const endAt = quietWindowEnd(now, start, end);
  if (!endAt) return null;
  if (missionScheduledAt && new Date(missionScheduledAt).getTime() < endAt.getTime() + EXCEPTION_LEAD_MS) {
    return null; // mission trop proche : envoi immédiat (exception BOSS)
  }
  return endAt;
}

// Version async : lit les réglages (cache getSetting) puis décide.
async function deferDeliveryAt(db, now, missionScheduledAt) {
  const start = Number(await getSetting(db, 'quiet_hours_start', 22));
  const end = Number(await getSetting(db, 'quiet_hours_end', 7));
  return deliveryPlan(now, start, end, missionScheduledAt);
}

module.exports = { casaParts, casaWallToInstant, isQuietHour, quietWindowEnd, deliveryPlan, deferDeliveryAt, EXCEPTION_LEAD_MS };
