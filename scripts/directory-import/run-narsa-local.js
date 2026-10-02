#!/usr/bin/env node
// NARSA (centres de visite technique) — import LOCAL MANUEL vers la base de PRODUCTION.
//
// Phase 5 quinquies (2026-10-01), décision BOSS : retiré de run-monthly-import.js (Cron Render).
// Confirmé via les logs du run Render n°2 : ConnectTimeout systématique depuis l'IP Render
// (Frankfurt) vers khadamatnarsa.ma, alors que ça fonctionne depuis une IP marocaine — blocage des
// IP étrangères côté WAF NARSA, pas un bug de ce pipeline. Ce script remplace donc l'étape NARSA du
// Cron pour ce domaine uniquement (santé et administrations restent sur le Cron Render) : à
// exécuter MANUELLEMENT, une fois par mois (ou à la demande), depuis un poste au Maroc.
//
// Usage : npm run import:narsa   (depuis scripts/directory-import/)
//
// Lit DATABASE_URL et VERCEL_DEPLOY_HOOK_URL depuis un fichier .env LOCAL, HORS DES DEUX DÉPÔTS,
// jamais committé — voir RAPPORT_PHASE5QUINQUIES.md pour l'emplacement exact et comment obtenir
// chaque valeur. Les valeurs de ce fichier sont TOUJOURS prioritaires sur une variable du même nom
// déjà présente dans l'environnement (comportement volontaire : ce script doit toujours pointer sur
// ce que dit le fichier dédié, jamais sur un résidu d'une autre session de terminal).
//
// Mêmes garanties que le Cron Render : run-import-narsa.js n'écrit qu'en upsert, jamais de DELETE —
// un échec à n'importe quelle étape n'efface aucune fiche existante.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LOCAL_ENV_PATH = path.join(__dirname, '..', '..', '..', 'seo-study', '.env.narsa-production');
const REQUIRED_KEYS = ['DATABASE_URL'];
const OPTIONAL_KEYS = ['VERCEL_DEPLOY_HOOK_URL'];

function cleanValue(raw) {
  const trimmed = raw.trim();
  // Guillemets retirés seulement s'ils encadrent toute la valeur (pas un '#'/'$'/'@' au milieu).
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

// Parseur robuste : BOM, CRLF/LF/CR, lignes vides, commentaires (#...), valeur prise
// telle quelle après le premier "=" (jamais via regex, pour ne pas trébucher sur
// des caractères spéciaux comme # $ @ % * dans un mot de passe).
function loadLocalEnv() {
  if (!fs.existsSync(LOCAL_ENV_PATH)) {
    console.error(`ARRÊT : fichier introuvable : ${LOCAL_ENV_PATH}`);
    console.error('Ce fichier doit exister et contenir DATABASE_URL=... (et idéalement VERCEL_DEPLOY_HOOK_URL=...).');
    console.error('Voir RAPPORT_PHASE5QUINQUIES.md pour où trouver chaque valeur.');
    process.exit(2);
  }
  let content = fs.readFileSync(LOCAL_ENV_PATH, 'utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // BOM
  const found = new Set();
  for (const rawLine of content.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = cleanValue(line.slice(eq + 1));
    process.env[key] = value; // écrase volontairement une variable déjà présente
    found.add(key);
  }
  console.log(`(diagnostic) clés lues dans ${path.basename(LOCAL_ENV_PATH)} : ` +
    [...found].map((k) => `${k}(longueur=${process.env[k].length})`).join(', ') || '(aucune)');
  const missing = REQUIRED_KEYS.filter((k) => !found.has(k));
  if (missing.length > 0) {
    console.error(`ARRÊT : variable(s) manquante(s) dans ${LOCAL_ENV_PATH} : ${missing.join(', ')}`);
    process.exit(2);
  }
  for (const k of OPTIONAL_KEYS) {
    if (!found.has(k)) console.log(`(info) ${k} absent de ${LOCAL_ENV_PATH} — étape correspondante ignorée proprement.`);
  }
}

function run(script, ...args) {
  console.log(`\n=== ${script} ${args.join(' ')} ===`);
  execFileSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit', cwd: __dirname });
}

async function callDeployHook() {
  const url = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!url) { console.log('VERCEL_DEPLOY_HOOK_URL absent — republication Vercel NON déclenchée.'); return; }
  const res = await fetch(url, { method: 'POST' });
  console.log('Deploy Hook Vercel appelé — status', res.status);
}

async function main() {
  loadLocalEnv();

  console.log('\n############################################################');
  console.log('#  ATTENTION : ce script écrit dans la base de PRODUCTION.  #');
  console.log('############################################################\n');
  // DATABASE_URL et VERCEL_DEPLOY_HOOK_URL ne sont JAMAIS affichés (contiennent des secrets).

  try {
    run('fetch-narsa-cct.js');
    run('assign-neighborhoods-narsa.js');
    run('run-import-narsa.js');
    console.log('\nNARSA : import terminé avec succès.');
    await callDeployHook();
  } catch (e) {
    console.error('\nNARSA : échec —', e.message);
    console.error("Aucune fiche existante n'a été supprimée (chaque étape n'écrit qu'en upsert, jamais de DELETE).");
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { main };
