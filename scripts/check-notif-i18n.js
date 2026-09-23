#!/usr/bin/env node
// Détecte la dérive entre la copie backend des traductions notif.* (src/i18n/notif.{fr,ar}.json
// — option B, chantier langue des notifications push, 2026-09-23 : voir
// rapport-chantier-audit-langue-push-notifications-2026-09-23.md pour le choix A/B) et la source
// frontend (shoofly-react/src/i18n/locales/{fr,ar}.json, objet `notif`). Ne corrige rien, ne casse
// jamais un build : sortie 0 dans tous les cas, y compris quand le dépôt frontend est absent
// (déploiement backend seul, ex. Render) — c'est un rappel visuel pour un humain, pas une porte CI.
//
// Chemin relatif adapté à la structure réelle des deux dépôts sur cette machine
// (C:\laragon\www\Shoofly\backend et C:\laragon\www\shoofly-react, PAS www\Shoofly\shoofly-react)
// — à ajuster si l'un des deux dépôts est déplacé.
const fs = require('fs');
const path = require('path');

const FRONTEND_LOCALES_DIR = path.resolve(__dirname, '..', '..', '..', 'shoofly-react', 'src', 'i18n', 'locales');
const BACKEND_I18N_DIR = path.resolve(__dirname, '..', 'src', 'i18n');
const LANGS = ['fr', 'ar'];

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

if (!fs.existsSync(FRONTEND_LOCALES_DIR)) {
  console.log(`[check:notif-i18n] Dépôt frontend introuvable (${FRONTEND_LOCALES_DIR}) — vérification sautée, rien à signaler.`);
  process.exit(0);
}

let anyIssue = false;

for (const lang of LANGS) {
  const frontendPath = path.join(FRONTEND_LOCALES_DIR, `${lang}.json`);
  const backendPath = path.join(BACKEND_I18N_DIR, `notif.${lang}.json`);

  if (!fs.existsSync(frontendPath) || !fs.existsSync(backendPath)) {
    console.log(`[check:notif-i18n] [${lang}] fichier manquant (${frontendPath} ou ${backendPath}) — sauté.`);
    continue;
  }

  const frontendNotif = loadJson(frontendPath).notif || {};
  const backendNotif = loadJson(backendPath);

  const backendOnly = Object.keys(backendNotif).filter((k) => frontendNotif[k] === undefined);
  const frontendOnly = Object.keys(frontendNotif).filter((k) => backendNotif[k] === undefined);
  const differing = Object.keys(backendNotif).filter((k) => frontendNotif[k] !== undefined && frontendNotif[k] !== backendNotif[k]);

  console.log(`\n[check:notif-i18n] [${lang}] backend: ${Object.keys(backendNotif).length} clés — frontend notif.*: ${Object.keys(frontendNotif).length} clés`);

  if (backendOnly.length) {
    anyIssue = true;
    console.log(`  ⚠️  ${backendOnly.length} clé(s) présente(s) SEULEMENT côté backend (anomalie — copiées d'où ?) :`);
    backendOnly.forEach((k) => console.log(`     - ${k}`));
  }

  if (differing.length) {
    anyIssue = true;
    console.log(`  ⚠️  ${differing.length} clé(s) avec un TEXTE DIFFÉRENT entre backend et frontend (dérive) :`);
    differing.forEach((k) => {
      console.log(`     - ${k}`);
      console.log(`       frontend: ${JSON.stringify(frontendNotif[k])}`);
      console.log(`       backend : ${JSON.stringify(backendNotif[k])}`);
    });
  }

  if (frontendOnly.length) {
    console.log(`  ℹ️  ${frontendOnly.length} clé(s) frontend non copiées côté backend — normal, le backend ne copie QUE les clés utilisées par notify() (sous-ensemble volontaire, option B).`);
  }

  if (!backendOnly.length && !differing.length) {
    console.log(`  ✅ Aucune dérive détectée pour les clés copiées.`);
  }
}

console.log(anyIssue
  ? '\n[check:notif-i18n] Dérive(s) trouvée(s) ci-dessus — outil informatif, sortie 0 quand même (ne bloque jamais un build).'
  : '\n[check:notif-i18n] OK.');
process.exit(0);
