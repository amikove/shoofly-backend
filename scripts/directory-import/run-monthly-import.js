#!/usr/bin/env node
// Orchestrateur du pipeline mensuel complet (Phase 4, décision #3) — destiné au service Cron Job
// Render DÉDIÉ (render.yaml, service "shoofly-directory-cron", séparé du service web "shoofly-api").
// Santé + administrations, puis appel du Deploy Hook Vercel pour republier les pages.
//
// Phase 5 quinquies (2026-10-01), décision BOSS : NARSA RETIRÉ de cet orchestrateur. Confirmé via
// les logs du run Render n°2 : ConnectTimeout systématique depuis l'IP Render (Frankfurt) vers
// khadamatnarsa.ma — blocage des IP étrangères côté NARSA, pas un bug de ce pipeline. NARSA
// s'importe désormais via `npm run import:narsa` (run-narsa-local.js), lancé MANUELLEMENT depuis un
// poste au Maroc (voir ce fichier pour le détail — mêmes garanties : upsert uniquement, jamais de
// suppression de fiche en cas d'échec).
//
// Résilience (décision #6) : chaque domaine (santé / administrations) est isolé dans son propre
// try/catch — l'échec d'UN domaine n'empêche jamais l'autre de s'importer, et n'efface JAMAIS les
// fiches déjà en base de ce domaine (chaque run-import-*.js n'écrit qu'en upsert, jamais de DELETE —
// voir leurs commentaires respectifs). Le Deploy Hook est appelé à la fin dans tous les cas où AU
// MOINS un domaine a réussi, pour republier ce qui a pu être mis à jour.
//
// Phase 5 sexies (2026-10-02), décision BOSS : run Render n°3, Overpass ("fetch failed") faisait
// échouer tout le domaine à chaque panne (une seule requête, un seul miroir, aucune retentative).
// fetch-neighborhoods-osm.js et fetch-osm-admin.js utilisent désormais overpass-client.js (retries,
// miroirs officiels, diagnostic détaillé) et DÉGRADENT PROPREMENT (exit 0, jamais une exception) si
// Overpass reste indisponible après tous les miroirs — voir ces 2 fichiers, assign-neighborhoods.js
// (repli sur le gazetteer déjà en base) et run-import-admin.js (exclusion des fiches
// primary_source='osm_overpass' de la détection "disparue" le temps qu'Overpass est indisponible).
//
// Ne PAS exécuter automatiquement dans ce chantier (Phase 4 : "aucun déploiement"). Prévu pour être
// lancé par le Cron Job Render une fois le service créé par BOSS.
//
// Phase 5 (2026-09-30) : MTNRA (fetch-mtnra.js) et les limites de ville (fetch-boundaries-
// nominatim.js) sont désormais téléchargés À L'EXÉCUTION (data.gov.ma / Nominatim), jamais
// committés.
//
// Phase 5 bis (2026-09-30) : les 3 domaines sont maintenant RÉELLEMENT indépendants entre eux.
// - fetch-boundaries-nominatim.js tourne séparément dans le bloc santé ET dans le bloc
//   administrations (chacun sa propre requête Nominatim, 1 seule requête à chaque fois pour les
//   3 villes) : un échec Nominatim pendant le bloc santé n'empêche plus les administrations de
//   récupérer les leurs, et inversement.
// - fetch-sources-admin.js (nouveau) câble les étapes Overture/Foursquare/OSM administrations qui
//   manquaient à l'orchestrateur (merge-classify-admin.js en a besoin, générées manuellement lors
//   de la Phase 2 bis jusqu'ici — jamais automatisées).
// - assign-neighborhoods-narsa.js lit le gazetteer de quartiers directement EN BASE (table
//   directory_neighborhoods) au lieu d'un fichier produit par le domaine santé : NARSA ne dépend
//   plus d'aucune autre étape de ce run.
// - fetch-neighborhoods-osm.js (quartiers OSM) manquait aussi au bloc santé : assign-neighborhoods.js
//   attendait out/osm_neighborhoods.json sans qu'aucune étape ne le génère — trouvé en testant
//   l'exécution autonome complète (le domaine santé échouait systématiquement sur un checkout
//   frais). Ajouté ici.
//
// Point ouvert (PAS corrigé, hors périmètre de cette demande) : assign-neighborhoods-admin.js lit
// out/neighborhoods.json, produit par assign-neighborhoods.js (domaine santé) — les
// administrations dépendent donc encore du succès du domaine santé PENDANT LE MÊME RUN pour
// rattacher leurs propres quartiers (fonctionne ici car santé s'exécute avant administrations,
// mais un échec santé priverait administrations de cette donnée). Même nature de couplage que ce
// qui vient d'être corrigé pour NARSA — à traiter séparément si BOSS le souhaite.

const { execFileSync } = require('child_process');
const path = require('path');

// Phase 5 ter (2026-10-01), décision BOSS : observé en testant que fetch-overture.child.js /
// fetch-overture-admin.child.js (DuckDB + S3) peuvent rester bloqués indéfiniment (CPU et mémoire
// figés, aucune progression) de façon intermittente, sans jamais lever d'erreur ni se terminer —
// rien n'empêchait cela de bloquer le Cron Job Render indéfiniment (jusqu'à sa limite dure de 12h).
// Deux garde-fous :
// - STEP_TIMEOUT_MS : chaque script enfant est tué (SIGTERM) s'il dépasse ce délai. L'échec est
//   ensuite traité comme n'importe quel autre échec d'étape par les try/catch existants (le domaine
//   est abandonné pour CE run, les autres domaines continuent normalement, aucune fiche supprimée —
//   chaque run-import-*.js n'écrit qu'en upsert).
// - TASK_TIMEOUT_MS : budget global pour toute la tâche. Vérifié avant CHAQUE étape (y compris la
//   toute première d'un domaine) : au-delà, les étapes/domaines pas encore commencés sont marqués
//   en échec sans être tentés, pour éviter qu'une série de blocages fasse dériver le job sur
//   plusieurs heures.
const STEP_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — large marge au-dessus du cas sain observé (Overture ~1-2 min quand ça fonctionne)
const TASK_TIMEOUT_MS = 60 * 60 * 1000; // 60 min pour l'ensemble du job (la limite dure Render est 12h)
const taskStart = Date.now();

function run(script, ...args) {
  const elapsed = Date.now() - taskStart;
  if (elapsed > TASK_TIMEOUT_MS) {
    throw new Error(`budget global de la tâche dépassé (${Math.round(TASK_TIMEOUT_MS / 60000)} min écoulées) — étape ${script} non tentée`);
  }
  console.log(`\n=== ${script} ${args.join(' ')} ===`);
  try {
    // killSignal: SIGKILL explicite (pas le SIGTERM par défaut) — sur Linux (Render), un process
    // bloqué dans du code natif (DuckDB) pourrait ignorer/retarder un SIGTERM ; on ne cherche pas
    // un arrêt propre d'un process qu'on a déjà décidé d'abandonner, juste une mort certaine.
    execFileSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit', cwd: __dirname, timeout: STEP_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } catch (e) {
    if (e.signal) {
      throw new Error(`${script} tué (${e.signal}) après dépassement du délai de ${Math.round(STEP_TIMEOUT_MS / 60000)} min — probable blocage réseau/DuckDB`);
    }
    throw e;
  }
}

async function callDeployHook() {
  const url = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!url) { console.log('VERCEL_DEPLOY_HOOK_URL absent — republication Vercel NON déclenchée (configurer la variable sur le service Cron Job Render).'); return; }
  const res = await fetch(url, { method: 'POST' });
  console.log('Deploy Hook Vercel appelé — status', res.status);
}

async function main() {
  const results = { sante: 'non tenté', administrations: 'non tenté' };

  try {
    run('fetch-boundaries-nominatim.js'); // limites de ville (Nominatim) — utilisées par les étapes suivantes
    run('fetch-sources.js');
    run('fetch-neighborhoods-osm.js'); // gazetteer quartiers OSM — manquait à l'orchestrateur (trouvé en testant, Phase 5 bis)
    run('merge-classify.js');
    run('assign-neighborhoods.js');
    run('run-import.js');
    results.sante = 'OK';
  } catch (e) { results.sante = 'ÉCHEC : ' + e.message; console.error('[santé] échec, domaine ignoré pour ce run :', e.message); }

  try {
    run('fetch-boundaries-nominatim.js'); // indépendant du bloc santé (Phase 5 bis) : chaque domaine fetch les siennes
    run('fetch-mtnra.js');
    run('fetch-sources-admin.js'); // Overture + Foursquare + OSM admin (Phase 5 bis, décision BOSS #1 : n'était câblé nulle part)
    run('merge-classify-admin.js');
    run('assign-neighborhoods-admin.js');
    run('run-import-admin.js');
    results.administrations = 'OK';
  } catch (e) { results.administrations = 'ÉCHEC : ' + e.message; console.error('[administrations] échec, domaine ignoré pour ce run :', e.message); }

  console.log('\n=== RÉSUMÉ DU RUN MENSUEL ===');
  console.log(JSON.stringify(results, null, 2));

  if (Object.values(results).some((r) => r === 'OK')) {
    await callDeployHook();
  } else {
    console.error('Aucun domaine importé avec succès — Deploy Hook NON appelé (rien de nouveau à republier).');
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { main };
