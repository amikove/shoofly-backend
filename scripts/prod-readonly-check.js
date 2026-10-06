#!/usr/bin/env node
// Vérification en LECTURE SEULE de la base de PRODUCTION. Ne modifie rien.
//  - DATABASE_URL lu depuis C:\laragon\www\Shoofly\seo-study\.env.narsa-production (même parsing et
//    même sslmode=verify-full que scripts/directory-import/run-narsa-local.js). Jamais affiché.
//  - Transaction BEGIN READ ONLY … ROLLBACK.
//  - Ne sélectionne ni numéro de téléphone, ni nom, ni contenu : seulement des agrégats.
// Usage : node scripts/prod-readonly-check.js
const fs = require('fs');
const path = require('path');

const ENV_PATH = 'C:\\laragon\\www\\Shoofly\\seo-study\\.env.narsa-production';

function ensureSslModeVerifyFull(url) {
  if (/[?&]sslmode=/i.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}sslmode=verify-full`;
}

function readDatabaseUrl() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error('ARRÊT : fichier d\'environnement de production introuvable.');
    process.exit(2);
  }
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== 'DATABASE_URL') continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return ensureSslModeVerifyFull(value);
  }
  console.error('ARRÊT : DATABASE_URL absent du fichier de production.');
  process.exit(2);
}

const QUERIES = {
  '1a. WhatsApp échecs, 30 jours, par modèle et code (agrégé)': `
    SELECT template_name,
           COALESCE(substring(error_message FROM 'PLAN_FEATURE_DISABLED|HTTP [0-9]{3}'), 'autre') AS code,
           COUNT(*)::int AS n
    FROM whatsapp_send_failures
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY 1, 2 ORDER BY n DESC`,
  '1a bis. PLAN_FEATURE_DISABLED en 30 jours (total)': `
    SELECT COUNT(*)::int AS n
    FROM whatsapp_send_failures
    WHERE created_at > NOW() - INTERVAL '30 days' AND error_message LIKE '%PLAN_FEATURE_DISABLED%'`,
  '1a ter. Envois WhatsApp réussis, 30 jours (journal, si présent)': `
    SELECT template_name, COUNT(*)::int AS n, MAX(created_at) AS dernier
    FROM whatsapp_send_log
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY 1 ORDER BY n DESC`,
  '1b. missionToVerifyAdminTitle, 7 jours (total et missions distinctes)': `
    SELECT COUNT(*)::int AS total, COUNT(DISTINCT mission_id)::int AS missions_distinctes
    FROM notifications
    WHERE title_key = 'missionToVerifyAdminTitle' AND created_at > NOW() - INTERVAL '7 days'`,
  '3. Missions active/en_route dont le créneau est dépassé de plus de 24 h (nombre, ancienneté max)': `
    SELECT COUNT(*)::int AS nombre,
           ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - scheduled_at))) / 3600.0, 1) AS anciennete_max_heures
    FROM missions
    WHERE status IN ('active', 'en_route')
      AND scheduled_at < NOW() - INTERVAL '24 hours'
      AND oeil_id IS NOT NULL`,
};

async function main() {
  const { Client } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
  const client = new Client({ connectionString: readDatabaseUrl() });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    for (const [label, sql] of Object.entries(QUERIES)) {
      console.log(`\n== ${label}`);
      // SAVEPOINT : une requête en erreur (ex. table absente) n'annule pas les suivantes.
      await client.query('SAVEPOINT q');
      try {
        const { rows } = await client.query(sql);
        await client.query('RELEASE SAVEPOINT q');
        console.log(rows.length ? rows : '(aucune ligne)');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT q');
        console.log(`(non disponible : ${e.code || 'erreur'})`);
      }
    }
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  // Pas de message brut : il pourrait contenir des informations de connexion.
  console.error(`Échec de connexion ou de lecture (code : ${e.code || 'inconnu'})`);
  process.exit(1);
});
