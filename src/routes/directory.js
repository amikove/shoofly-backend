// Chantier SEO annuaire — Phase 2 (2026-09-30). Circuit "Demander le retrait" / "Signaler une
// erreur" : endpoint PUBLIC (aucune authentification) — voir PLAN_SEO_ANNUAIRE.md §G pour la
// justification (un visiteur qui tombe sur une fiche depuis Google n'a le plus souvent pas de
// compte Shoofly ; support_tickets exige un user_id, volontairement pas réutilisé ici).
//
// LICENCES (Phase 3 décision #5, révisé Phase 4 décision #2, 2026-09-30) — directory_establishments/
// directory_neighborhoods contiennent des données ODbL (OpenStreetMap via Overpass, MTNRA/
// data.gov.ma). L'ODbL impose le partage à l'identique ("share-alike") si la BASE elle-même (pas
// seulement les pages produites) est PUBLIQUEMENT distribuée — voir RAPPORT_PHASE2BIS.md §4.
// AUCUNE route de ce fichier ne renvoie la base en masse SANS AUTHENTIFICATION. Deux exceptions
// contrôlées : (1) GET /reports (public, mais une fiche UNITAIRE par requête, jamais une liste) ;
// (2) GET /export (Phase 4 décision #2), protégée par un jeton secret (DIRECTORY_EXPORT_TOKEN,
// header dédié, comparaison à temps constant, 401 sans jeton valide) — utilisée UNIQUEMENT par le
// build du générateur SSG (shoofly-react/scripts/directory-ssg/generate.cjs), jamais par un
// visiteur. Le commentaire "pas d'export public" reste vrai : /export n'est pas public, elle est
// protégée par un secret que seul Vercel (variable d'environnement de build) détient.
const crypto = require('crypto');
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db/schema');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const asyncHandler = require('../middleware/asyncHandler');
const { getPublishedDirectoryData } = require('../utils/directoryExport');
const { directoryRebuild } = require('../utils/directoryRebuild');

// Comparaison à temps constant du jeton — évite une attaque par mesure de temps sur une comparaison
// naïve (===) qui court-circuite au premier octet différent. crypto.timingSafeEqual exige deux
// buffers de MÊME longueur : on compare d'abord la longueur (fuite négligeable, la longueur d'un
// jeton n'est pas un secret), sinon timingSafeEqual lèverait au lieu de renvoyer false.
function safeTokenEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// GET /api/directory/export — protégée par jeton, réservée au build du générateur SSG. Refuse de
// démarrer si le serveur lui-même n'a pas de jeton configuré (fail closed : un déploiement qui a
// oublié DIRECTORY_EXPORT_TOKEN refuse tout accès plutôt que de l'exposer sans protection).
router.get('/export', asyncHandler(async (req, res) => {
  const expected = process.env.DIRECTORY_EXPORT_TOKEN;
  if (!expected) return res.status(401).json({ error: 'Export non configuré' });
  const provided = req.headers['x-directory-export-token'];
  if (!provided || !safeTokenEqual(provided, expected)) return res.status(401).json({ error: 'Jeton invalide' });

  const db = getDb();
  const data = await getPublishedDirectoryData(db);
  res.json(data);
}));

const REPORT_TYPES = ['retrait', 'erreur'];

// 5 signalements / 15 min par IP — même ordre de grandeur que registerLimiter (index.js), un
// formulaire public sans compte est une cible spam évidente mais un usage légitime reste rare par
// visiteur (voir PLAN_SEO_ANNUAIRE.md §G, "anti-abus").
const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de signalements depuis cette adresse. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip || '')).digest('hex');
}

// POST /api/directory/reports — public, sans authentification.
router.post('/reports', reportLimiter, asyncHandler(async (req, res) => {
  const db = getDb();
  const { establishment_id, type, message, contact_email } = req.body;

  if (!establishment_id) return res.status(400).json({ error: 'establishment_id requis' });
  if (!REPORT_TYPES.includes(type)) return res.status(400).json({ error: 'type invalide (retrait ou erreur)' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message requis' });

  const { rows: [establishment] } = await db.query('SELECT id FROM directory_establishments WHERE id=$1', [establishment_id]);
  if (!establishment) return res.status(404).json({ error: 'Établissement introuvable' });

  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO directory_reports (id, establishment_id, type, message, contact_email, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, establishment_id, type, message.trim(), contact_email || null, hashIp(req.ip)]
  );
  res.status(201).json({ id, status: 'pending' });
}));

// GET /api/directory/admin/reports — admin, permission moderation.
router.get('/admin/reports', authenticate, requirePermission('moderation'), asyncHandler(async (req, res) => {
  const db = getDb();
  const status = ['pending', 'actioned', 'dismissed'].includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await db.query(
    `SELECT r.*, e.name AS establishment_name, e.city AS establishment_city, e.slug AS establishment_slug
     FROM directory_reports r JOIN directory_establishments e ON e.id = r.establishment_id
     WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 200`,
    [status]
  );
  res.json(rows);
}));

// PUT /api/directory/admin/reports/:id — admin, permission moderation.
// action='actioned' + type='retrait' du signalement d'origine → retrait DÉFINITIF (status='removed'
// + directory_exclusions, décision #11 du plan initial : la fiche ne réapparaîtra plus jamais,
// même après un réimport — voir scripts/directory-import/run-import.js, vérification isExcluded()
// AVANT tout upsert).
router.put('/admin/reports/:id', authenticate, requirePermission('moderation'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { action } = req.body; // 'actioned' | 'dismissed'
  if (!['actioned', 'dismissed'].includes(action)) return res.status(400).json({ error: 'action invalide' });

  const { rows: [report] } = await db.query(
    `SELECT r.*, e.overture_id, e.foursquare_id, e.mtnra_id, e.osm_id, e.narsa_id, e.name AS establishment_name
     FROM directory_reports r JOIN directory_establishments e ON e.id = r.establishment_id
     WHERE r.id=$1`,
    [req.params.id]
  );
  if (!report) return res.status(404).json({ error: 'Signalement introuvable' });
  if (report.status !== 'pending') return res.status(409).json({ error: 'Signalement déjà traité' });

  await db.query(
    `UPDATE directory_reports SET status=$1, reviewed_by=$2, reviewed_at=NOW() WHERE id=$3`,
    [action, req.user.id, report.id]
  );

  // Une fiche a 1 à 4 identifiants source (overture/foursquare/mtnra/osm_overpass, voir
  // db/schema.js directory_establishments) — un retrait doit exclure TOUS ceux présents, pas
  // seulement overture/foursquare : sinon une fiche administration (mtnra_id/osm_id, ajoutés en
  // Phase 2 bis) repasserait au prochain import (bug trouvé en testant dans un navigateur réel,
  // corrigé ici — voir RAPPORT_PHASE2BIS.md).
  let rebuildScheduled = false;
  if (action === 'actioned' && report.type === 'retrait') {
    await db.query(`UPDATE directory_establishments SET status='removed', updated_at=NOW() WHERE id=$1`, [report.establishment_id]);
    const sourceIds = [
      ['overture', report.overture_id],
      ['foursquare', report.foursquare_id],
      ['mtnra', report.mtnra_id],
      ['osm_overpass', report.osm_id],
      ['narsa', report.narsa_id],
    ];
    for (const [source, sourceId] of sourceIds) {
      if (!sourceId) continue;
      await db.query(
        `INSERT INTO directory_exclusions (source, source_id, reason, establishment_name_at_exclusion, excluded_by_report_id, excluded_by_admin_id)
         VALUES ($1,$2,'retrait confirmé par admin',$3,$4,$5) ON CONFLICT (source, source_id) DO NOTHING`,
        [source, sourceId, report.establishment_name, report.id, req.user.id]
      );
    }
    // Exclusions en base : le rebuild peut partir. Asynchrone et anti-rafale (utils/directoryRebuild.js),
    // un échec du hook ne fait jamais échouer le retrait.
    rebuildScheduled = directoryRebuild.request();
  }

  res.json({ ok: true, rebuild_scheduled: rebuildScheduled });
}));

module.exports = router;
