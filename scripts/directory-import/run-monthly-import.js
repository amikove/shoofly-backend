#!/usr/bin/env node
// Orchestrateur du pipeline mensuel complet (Phase 4, décision #3) — destiné au service Cron Job
// Render DÉDIÉ (render.yaml, service "shoofly-directory-cron", séparé du service web "shoofly-api").
// Santé + administrations + NARSA CCT, puis appel du Deploy Hook Vercel pour republier les pages.
//
// Résilience (décision #6, étendue ici aux 3 sources) : chaque domaine (santé / administrations /
// NARSA) est isolé dans son propre try/catch — l'échec d'UN domaine (ex. NARSA change de structure
// HTML, ou data.gov.ma est indisponible) n'empêche jamais les autres domaines de s'importer, et
// n'efface JAMAIS les fiches déjà en base de ce domaine (chaque run-import-*.js n'écrit qu'en
// upsert, jamais de DELETE — voir leurs commentaires respectifs). Le Deploy Hook est appelé à la
// fin dans tous les cas où AU MOINS un domaine a réussi, pour republier ce qui a pu être mis à jour.
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

function run(script, ...args) {
  console.log(`\n=== ${script} ${args.join(' ')} ===`);
  execFileSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit', cwd: __dirname });
}

async function callDeployHook() {
  const url = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!url) { console.log('VERCEL_DEPLOY_HOOK_URL absent — republication Vercel NON déclenchée (configurer la variable sur le service Cron Job Render).'); return; }
  const res = await fetch(url, { method: 'POST' });
  console.log('Deploy Hook Vercel appelé — status', res.status);
}

async function main() {
  const results = { sante: 'non tenté', administrations: 'non tenté', narsa: 'non tenté' };

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

  try {
    // Phase 5 bis (2026-09-30), décision BOSS #2 : NARSA ne dépend plus d'aucune sortie du domaine
    // santé — assign-neighborhoods-narsa.js interroge directement le gazetteer déjà en base
    // (table directory_neighborhoods). Un échec santé ne bloque donc plus jamais NARSA.
    run('fetch-narsa-cct.js');
    run('assign-neighborhoods-narsa.js');
    run('run-import-narsa.js');
    results.narsa = 'OK';
  } catch (e) { results.narsa = 'ÉCHEC : ' + e.message; console.error('[NARSA] échec, domaine ignoré pour ce run :', e.message); }

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
