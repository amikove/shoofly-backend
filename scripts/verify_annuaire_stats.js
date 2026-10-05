// Vérification des statistiques annuaire (feat/annuaire-stats, 2026-10-05). Contre le backend LOCAL
// (port 3001) et sa base locale. Lance : node scripts/verify_annuaire_stats.js
// Nettoie uniquement ses propres lignes : missions de titre "[TEST annuaire-stats]" et compteurs de la
// fiche de test (table créée par cette branche : aucune donnée préexistante).
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { getDb } = require('../src/db/schema');
const API = process.env.VERIFY_API || 'http://localhost:3001';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ' (' + detail + ')' : ''}`);
};

async function event(body, ua = UA, raw = null) {
  const res = await fetch(`${API}/api/directory/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'User-Agent': ua },
    body: raw ?? JSON.stringify(body),
  });
  return res.status;
}

(async () => {
  const db = getDb();
  const { rows: [est] } = await db.query(`SELECT id, name FROM directory_establishments WHERE status='published' ORDER BY id LIMIT 1`);
  if (!est) throw new Error('Aucune fiche publiée en base');

  const dayCount = async (id, ev) => {
    const { rows: [r] } = await db.query(
      `SELECT COALESCE(SUM(count),0)::int AS n FROM directory_establishment_daily_stats
       WHERE establishment_id=$1 AND event=$2 AND day=(NOW() AT TIME ZONE 'Africa/Casablanca')::date`,
      [id, ev]
    );
    return r.n;
  };

  // Événements : types, agrégation, bot, fiche inconnue
  const v0 = await dayCount(est.id, 'view');
  const i0 = await dayCount(est.id, 'itineraire');
  check('vue valide (text/plain, sendBeacon) → 204', (await event({ establishment_id: est.id, type: 'view' })) === 204);
  check('deuxième vue le même jour → agrégée (+2 au total)', (await event({ establishment_id: est.id, type: 'view' })) === 204 && (await dayCount(est.id, 'view')) === v0 + 2);
  check('clic itinéraire → compteur propre (+1), vues inchangées', (await event({ establishment_id: est.id, type: 'itineraire' })) === 204 && (await dayCount(est.id, 'itineraire')) === i0 + 1 && (await dayCount(est.id, 'view')) === v0 + 2);
  check('type invalide → 400, aucun compteur ajouté', (await event({ establishment_id: est.id, type: 'hack' })) === 400 && (await dayCount(est.id, 'view')) === v0 + 2);
  check('identifiant absent → 400', (await event({ type: 'view' })) === 400);
  check('JSON mal formé → 400', (await event(null, UA, '{pas du json')) === 400);
  check('fiche inconnue → 204, aucune ligne créée', (await event({ establishment_id: 'inconnue-test-xyz', type: 'view' })) === 204 && (await db.query(`SELECT 1 FROM directory_establishment_daily_stats WHERE establishment_id='inconnue-test-xyz'`)).rowCount === 0);
  const { rows: [removed] } = await db.query(`SELECT id FROM directory_establishments WHERE status='removed' LIMIT 1`);
  if (removed) {
    const b = await dayCount(removed.id, 'view');
    check('fiche retirée → 204, aucun compteur', (await event({ establishment_id: removed.id, type: 'view' })) === 204 && (await dayCount(removed.id, 'view')) === b);
  } else console.log('SKIP — aucune fiche retirée en base');
  const bv = await dayCount(est.id, 'view');
  check('robot (Googlebot) → 204, aucune écriture', (await event({ establishment_id: est.id, type: 'view' }, 'Mozilla/5.0 (compatible; Googlebot/2.1)')) === 204 && (await dayCount(est.id, 'view')) === bv);

  // Limite de fréquence : 60 / 10 min par IP — envoi jusqu'à obtenir un 429
  let accepted = 0, limited = false;
  for (let i = 0; i < 80 && !limited; i++) {
    const s = await event({ establishment_id: est.id, type: 'site_web' });
    if (s === 429) limited = true; else if (s === 204) accepted++;
  }
  check('limite de fréquence : 429 atteint', limited, `acceptés dans la rafale avant 429 : ${accepted}`);

  // Missions : création depuis une fiche vs création normale
  const { rows: [client] } = await db.query(`SELECT id FROM users WHERE role='client' AND phone IS NOT NULL LIMIT 1`);
  if (!client) console.log('SKIP — aucun client avec téléphone : tests missions non exécutés');
  else {
    const token = jwt.sign({ id: client.id, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const body = (extra) => ({
      type: 'file_attente', title: '[TEST annuaire-stats] mission test', address: 'Rabat test', city: 'Rabat',
      scheduled_at: new Date(Date.now() + 3 * 86400e3).toISOString(), price: 85, payment_method: 'cash', replacement_preference: 'fast',
      location_lat: 34.0209, location_lng: -6.8416, ...extra,
    });
    const post = (b) => fetch(`${API}/api/missions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(b),
    });
    const colOf = async (res) => {
      const j = await res.json().catch(() => ({}));
      if (res.status !== 201) console.log('  diagnostic mission :', res.status, JSON.stringify(j).slice(0, 300));
      const id = j.id || j.mission?.id;
      if (!id) return { id: null, col: undefined };
      const { rows: [r] } = await db.query(`SELECT directory_establishment_id FROM missions WHERE id=$1`, [id]);
      return { id, col: r?.directory_establishment_id };
    };
    const rFiche = await post(body({ directory_establishment_id: est.id }));
    const mFiche = await colOf(rFiche);
    check('mission créée depuis une fiche → 201, identifiant enregistré', rFiche.status === 201 && mFiche.col === est.id, `status ${rFiche.status}`);
    const rNormal = await post(body({}));
    const mNormal = await colOf(rNormal);
    check('mission normale (sans fiche) → 201, colonne NULL', rNormal.status === 201 && mNormal.col === null, `status ${rNormal.status}`);
    const rUnknown = await post(body({ directory_establishment_id: 'inconnue-test-xyz' }));
    const mUnknown = await colOf(rUnknown);
    check('identifiant de fiche inconnu → mission créée, colonne NULL', rUnknown.status === 201 && mUnknown.col === null, `status ${rUnknown.status}`);

    // Endpoint admin
    const anon = await fetch(`${API}/api/directory/admin/stats?period=all`);
    check('stats admin sans jeton → 401', anon.status === 401);
    const asClient = await fetch(`${API}/api/directory/admin/stats?period=all`, { headers: { Authorization: `Bearer ${token}` } });
    check('stats admin avec compte client → 403', asClient.status === 403);
    const { rows: [sa] } = await db.query(`SELECT id, role FROM users WHERE email='admin@shoofly.ma' AND is_super_admin=true LIMIT 1`);
    if (sa) {
      const adminToken = jwt.sign({ id: sa.id, role: sa.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
      const r = await fetch(`${API}/api/directory/admin/stats?period=all`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const j = await r.json();
      const row = j.rows?.find((x) => x.id === est.id);
      check('stats admin : fiche de test avec vues, itinéraires et missions', r.status === 200 && row && row.views >= 2 && row.itineraire >= 1 && row.missions >= 1, `vues=${row?.views} itin=${row?.itineraire} missions=${row?.missions}`);
      check('stats admin : totaux = somme des lignes', j.totals && j.totals.missions === j.rows.reduce((s, x) => s + x.missions, 0));
      const bad = await fetch(`${API}/api/directory/admin/stats?period=365`, { headers: { Authorization: `Bearer ${adminToken}` } });
      check('stats admin : période invalide → 400', bad.status === 400);
    } else console.log('SKIP — pas de super admin en base');

    const { rows: testMissions } = await db.query(`SELECT id FROM missions WHERE title = '[TEST annuaire-stats] mission test' AND client_id = $1`, [client.id]);
    const testIds = testMissions.map((m) => m.id);
    if (testIds.length) {
      // Toutes les tables qui référencent missions (notifications, verrous de création, …) : seules nos lignes.
      const { rows: refs } = await db.query(
        `SELECT DISTINCT kcu.table_name, kcu.column_name
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name AND kcu.table_schema = rc.constraint_schema
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = rc.unique_constraint_name AND ccu.table_schema = rc.unique_constraint_schema
         WHERE ccu.table_name = 'missions' AND kcu.table_name <> 'missions' AND kcu.table_schema = current_schema()`
      );
      for (const r of refs) await db.query(`DELETE FROM "${r.table_name}" WHERE "${r.column_name}" = ANY($1)`, [testIds]);
      await db.query(`DELETE FROM missions WHERE id = ANY($1)`, [testIds]);
    }
  }
  await db.query(`DELETE FROM directory_establishment_daily_stats WHERE establishment_id = $1 OR establishment_id = 'inconnue-test-xyz'`, [est.id]);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nRÉSULTAT : ${results.length - failed}/${results.length} PASS${failed ? ' — ÉCHECS : ' + failed : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERREUR TEST:', e.message); process.exit(1); });
