// Chantier retrait → republication (2026-10-05). Quand BOSS confirme un retrait dans l'admin, la fiche
// doit quitter le site sans attendre le prochain build Vercel (au pire un mois). On déclenche donc un
// rebuild via le Deploy Hook Vercel (VERCEL_DEPLOY_HOOK_URL, même valeur que shoofly-directory-cron).
//
// - Anti-rafale leading + trailing : le PREMIER retrait déclenche l'appel immédiatement ; les retraits
//   suivants pendant la fenêtre de 5 min sont regroupés en UN appel à la fin de la fenêtre.
//   1 retrait → 1 appel. Rafale de 3 → 2 appels (1 immédiat + 1 en fin de fenêtre).
// - Asynchrone : l'appel ne bloque jamais la réponse admin ; un échec est journalisé, jamais propagé.
// - Variable absente : aucun appel, avertissement dans les logs, et la demande renvoie false.
// - L'URL du hook est un secret : elle n'est JAMAIS journalisée.
const DEFAULT_DELAY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;

function createDirectoryRebuild({ env = process.env, fetchImpl = fetch, delayMs = DEFAULT_DELAY_MS } = {}) {
  let windowTimer = null; // fenêtre d'anti-rafale ouverte
  let pending = false;    // demande reçue pendant la fenêtre, pas encore envoyée

  async function fire() {
    const url = env.VERCEL_DEPLOY_HOOK_URL;
    if (!url) {
      console.warn('[annuaire] VERCEL_DEPLOY_HOOK_URL absent au moment du rebuild — aucun appel Vercel.');
      return;
    }
    try {
      const res = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) console.log('[annuaire] Deploy Hook Vercel appelé (rebuild après retrait) — status', res.status);
      else console.error('[annuaire] Deploy Hook Vercel en échec — HTTP', res.status, '(la fiche retirée restera en ligne jusqu\'au prochain build)');
    } catch (err) {
      console.error('[annuaire] Deploy Hook Vercel en échec —', err.name, '(la fiche retirée restera en ligne jusqu\'au prochain build)');
    }
  }

  function openWindow() {
    windowTimer = setTimeout(onWindowEnd, delayMs);
    windowTimer.unref();
  }

  // Fin de fenêtre : si des retraits sont arrivés entre-temps, UN appel groupé, puis une nouvelle fenêtre.
  function onWindowEnd() {
    windowTimer = null;
    if (!pending) return;
    pending = false;
    fire();
    openWindow();
  }

  // Retourne true si un rebuild est prévu (immédiat ou en fin de fenêtre), false si la variable est absente.
  function request() {
    if (!env.VERCEL_DEPLOY_HOOK_URL) {
      console.warn('[annuaire] VERCEL_DEPLOY_HOOK_URL absent — retrait confirmé sans republication automatique (configurer la variable sur le service shoofly-api).');
      return false;
    }
    if (windowTimer) {
      pending = true;
    } else {
      fire();
      openWindow();
    }
    return true;
  }

  return { request };
}

module.exports = { createDirectoryRebuild, directoryRebuild: createDirectoryRebuild() };
