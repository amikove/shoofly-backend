// Chantier retrait → republication (2026-10-05). Quand BOSS confirme un retrait dans l'admin, la fiche
// doit quitter le site sans attendre le prochain build Vercel (au pire un mois). On déclenche donc un
// rebuild via le Deploy Hook Vercel (VERCEL_DEPLOY_HOOK_URL, même valeur que shoofly-directory-cron).
//
// - Anti-rafale : les demandes arrivant pendant la fenêtre de regroupement donnent UN SEUL appel, à la
//   fin de la fenêtre (3 retraits en 2 minutes = 1 rebuild).
// - Asynchrone : l'appel ne bloque jamais la réponse admin ; un échec est journalisé, jamais propagé.
// - Variable absente : aucun appel, avertissement dans les logs, et la demande renvoie false.
// - L'URL du hook est un secret : elle n'est JAMAIS journalisée.
const DEFAULT_DELAY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;

function createDirectoryRebuild({ env = process.env, fetchImpl = fetch, delayMs = DEFAULT_DELAY_MS } = {}) {
  let timer = null;

  async function fire() {
    timer = null;
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

  // Retourne true si un rebuild est planifié, false si la variable est absente (aucun appel prévu).
  function request() {
    if (!env.VERCEL_DEPLOY_HOOK_URL) {
      console.warn('[annuaire] VERCEL_DEPLOY_HOOK_URL absent — retrait confirmé sans republication automatique (configurer la variable sur le service shoofly-api).');
      return false;
    }
    if (!timer) {
      timer = setTimeout(fire, delayMs);
      timer.unref();
    }
    return true;
  }

  return { request };
}

module.exports = { createDirectoryRebuild, directoryRebuild: createDirectoryRebuild() };
