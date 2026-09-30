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
// committés. fetch-boundaries-nominatim.js tourne en premier dans le bloc "santé" : un échec
// Nominatim fait donc échouer tout le domaine santé pour ce run (seul domaine qui en dépend
// aujourd'hui — voir son commentaire), mais jamais les administrations ni NARSA.

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
    run('merge-classify.js');
    run('assign-neighborhoods.js');
    run('run-import.js');
    results.sante = 'OK';
  } catch (e) { results.sante = 'ÉCHEC : ' + e.message; console.error('[santé] échec, domaine ignoré pour ce run :', e.message); }

  try {
    run('fetch-mtnra.js');
    run('merge-classify-admin.js');
    run('assign-neighborhoods-admin.js');
    run('run-import-admin.js');
    results.administrations = 'OK';
  } catch (e) { results.administrations = 'ÉCHEC : ' + e.message; console.error('[administrations] échec, domaine ignoré pour ce run :', e.message); }

  try {
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
