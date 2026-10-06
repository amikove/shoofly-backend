// ── Garde d'envoi (opt-in) ─────────────────────────────────────────────────────────────────────
// Aucun envoi réel (push, WhatsApp, e-mail) sauf si NOTIFICATIONS_LIVE=1. Sans cette variable :
// envoi bloqué et journalisé « [guard] envoi bloqué », quel que soit NODE_ENV et même si les clés
// d'envoi sont présentes dans l'environnement ou le .env. Les services appellent guardSend() AVANT
// tout appel réseau et ne doivent rien faire d'autre si elle renvoie faux.

function isLive(env = process.env) {
  return env.NOTIFICATIONS_LIVE === '1';
}

// Renvoie true si l'envoi peut partir. Sinon journalise et renvoie false (le caller répond
// « ignoré », sans jamais l'enregistrer comme échec).
function guardSend(channel, detail = '', env = process.env) {
  if (isLive(env)) return true;
  console.warn(`[guard] envoi bloqué (canal=${channel}${detail ? ', ' + detail : ''}) — NOTIFICATIONS_LIVE absent`);
  return false;
}

// Ligne de démarrage : visible dans les logs Render pour confirmer le mode.
function startupStatusLine(env = process.env) {
  return isLive(env)
    ? '[notifications] envois ACTIFS (NOTIFICATIONS_LIVE=1)'
    : '[notifications] envois BLOQUÉS (NOTIFICATIONS_LIVE absent)';
}

module.exports = { isLive, guardSend, startupStatusLine };
