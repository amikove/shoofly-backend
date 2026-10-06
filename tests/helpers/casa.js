// Heure murale de Africa/Casablanca via Intl (fuseau IANA) — jamais de décalage fixe : le Maroc
// passe à UTC+0 pendant le Ramadan et à UTC+1 le reste de l'année.

function casaParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Casablanca',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute') };
}

// Instant UTC pour « y-mo-d h:mi » heure de Casablanca (correction itérative du décalage).
function casaWallToInstant(y, mo, d, h, mi) {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = casaParts(new Date(guess));
    guess += target - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return new Date(guess);
}

// Décalage réel de Casablanca à un instant, en heures (0 pendant le Ramadan, 1 sinon).
function casaOffsetHours(date) {
  const p = casaParts(date);
  return (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - date.getTime()) / 3600000;
}

// Prochaine date (civile, Casablanca) tombant le jour de semaine `dow` (0 = dim, 6 = sam),
// à partir de `daysAhead` jours.
function nextCasaDate(dow, daysAhead) {
  for (let i = daysAhead; i < daysAhead + 14; i++) {
    const p = casaParts(new Date(Date.now() + i * 86400000));
    if (new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay() === dow) return { y: p.y, mo: p.mo, d: p.d };
  }
  throw new Error('jour introuvable');
}

module.exports = { casaParts, casaWallToInstant, casaOffsetHours, nextCasaDate };
