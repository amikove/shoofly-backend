// ── Disponibilité d'un Œil selon son créneau déclaré ────────
// Jour/heure "vus depuis le Maroc", pas ceux du process Node (voir 9e29a30 : Render
// tourne en UTC par défaut, non explicitement configuré — now.getDay()/getHours() sans
// timeZone dérive silencieusement selon l'hôte, y compris le jour calendaire autour de
// minuit heure marocaine).
function nowInMorocco(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Casablanca',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value;
  const weekdayMap = { Sun:'Dim', Mon:'Lun', Tue:'Mar', Wed:'Mer', Thu:'Jeu', Fri:'Ven', Sat:'Sam' };
  return {
    jour: weekdayMap[get('weekday')],
    hour: Number(get('hour')) % 24, // défensif : certains builds ICU rendent "24" à minuit avec hour12:false
    minute: Number(get('minute')),
  };
}

function isWithinSchedule(disponibilites, date = new Date()) {
  if (!disponibilites) return true; // pas de créneaux = on se fie au toggle manuel
  const d = typeof disponibilites === 'string' ? JSON.parse(disponibilites) : disponibilites;
  if (!Array.isArray(d) || d.length === 0) return true;
  const { jour, hour, minute } = nowInMorocco(date);
  const aujourdhui = d.find(x => x.jour === jour);
  if (!aujourdhui?.actif) return false;
  const [hd, md] = aujourdhui.debut.split(':').map(Number);
  const [hf, mf] = aujourdhui.fin.split(':').map(Number);
  const mins = hour * 60 + minute;
  return mins >= hd * 60 + md && mins <= hf * 60 + mf;
}

module.exports = { isWithinSchedule, nowInMorocco };
