const router = require('express').Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('../utils/cloudinaryStorage');
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { chatAccessExpiresAt } = require('./missions');
const { getSetting } = require('../utils/settings');

// ── Config Cloudinary ─────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder:         `shoofly/missions/${req.params.missionId}`,
    resource_type:  file.mimetype.startsWith('video') ? 'video' : 'image',
    allowed_formats: ['jpg','jpeg','png','webp','mp4','mov'],
    transformation: file.mimetype.startsWith('video') ? [] : [{ width: 1200, crop: 'limit' }],
  }),
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
fileFilter: (req, file, cb) => {
    file.originalname = file.originalname.replace(/[&<>"'`%;()]/g, '')
    const allowed = /jpeg|jpg|png|webp|mp4|mov/;
    if (allowed.test(file.mimetype) && allowed.test(file.originalname)) cb(null, true);
    else cb(new Error('Type de fichier non supporté'));
  }
});

// ── POST /api/media/:missionId ────────────────────────────
// L'autorisation doit être vérifiée AVANT tout upload Cloudinary — sinon n'importe quel
// utilisateur authentifié force un envoi réel (consommation de stockage) sur une mission qui
// n'est pas la sienne, avant même de savoir si la requête sera acceptée. `upload.array`
// déclenche l'upload dès le traitement multer (CloudinaryStorage._handleFile), pas après —
// donc ce middleware doit être placé AVANT lui dans la chaîne, jamais après.
async function checkMissionUploadAuthorization(req, res, next) {
  const db = getDb();
  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1', [req.params.missionId]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  const canUpload = req.user.role === 'admin'
    || req.user.role === 'oeil' && mission.oeil_id === req.user.id
    || req.user.role === 'client' && mission.client_id === req.user.id;
  if (!canUpload) return res.status(403).json({ error: 'Accès refusé' });

  if (!['active','en_route','assigned'].includes(mission.status)) {
    return res.status(400).json({ error: 'Mission non active' });
  }

  req.mission = mission;
  next();
}

router.post('/:missionId', authenticate, asyncHandler(checkMissionUploadAuthorization), upload.array('files', 10), asyncHandler(async (req, res) => {
  const db = getDb();
  const mission = req.mission;
  const inserted = [];

  for (const file of req.files || []) {
    const isVideo = file.mimetype.startsWith('video');
    const type    = isVideo ? 'video' : 'photo';
    const url     = file.path;
    const filename = file.filename || file.public_id || file.originalname;

    const { rows: [media] } = await db.query(
      `INSERT INTO mission_media (mission_id,uploader_id,type,filename,url,size_bytes,caption)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [mission.id, req.user.id, type, filename, url, file.size || 0, req.body.caption || null]
    );
    inserted.push(media);
  }

  // PROMPT 2 (2026-08-17) — détection d'abandon sans GPS : toute photo envoyée par l'Œil
  // assigné pendant que la mission est 'active' repousse l'échéance de la prochaine demande
  // (voir routes/missions.js POST /:id/status et index.js, cron d'alerte). N'importe quelle
  // photo compte (pas de distinction d'intention) — le seul signal disponible est "l'Œil est
  // toujours là et envoie quelque chose". Ne s'applique jamais aux vidéos/documents ni aux
  // uploads du client/admin.
  const hasPhoto = inserted.some(m => m.type === 'photo');
  if (hasPhoto && req.user.role === 'oeil' && mission.oeil_id === req.user.id && mission.status === 'active') {
    const activityPhotoIntervalMinutes = await getSetting(db, 'activity_photo_interval_minutes', 45);
    await db.query(
      `UPDATE missions SET activity_photo_next_due_at=$1, activity_photo_alerted=false WHERE id=$2`,
      [new Date(Date.now() + activityPhotoIntervalMinutes * 60 * 1000), mission.id]
    );
  }

  // Notifier le client
  if (inserted.length > 0 && req.user.role === 'oeil') {
    const emitToUser = req.app.get('emitToUser');
    const notifBody = `Votre Œil a envoyé ${inserted.length} ${inserted[0]?.type === 'video' ? 'vidéo(s)' : 'photo(s)'} pour "${mission.title}"`
    await db.query(
      `INSERT INTO notifications (user_id,title,body,type,mission_id,action_type,title_key,body_key,params) VALUES ($1,$2,$3,'media',$4,'mission_view',$5,$6,$7)`,
      [mission.client_id, '📸 Médias reçus', notifBody, mission.id, 'mediaReceivedTitle', 'mediaReceivedBody', JSON.stringify({ count: inserted.length, mediaType: inserted[0]?.type === 'video' ? 'vidéo(s)' : 'photo(s)', missionTitle: mission.title })]
    );

    const recipientId = req.user.id === mission.client_id ? mission.oeil_id : mission.client_id;
      if (emitToUser) emitToUser(recipientId, 'notification', {
        title: '📸 Médias reçus',
        body: notifBody,
        missionId: mission.id,
        type: 'message'
      });

  }

  res.status(201).json({ media: inserted, count: inserted.length });
}));

// ── GET /api/media/:missionId ─────────────────────────────
// Route indépendante du chargement de la mission (missions.js GET /:id) — c'est elle que
// ChatModal.jsx (mediaAPI.list) appelle en parallèle pour fusionner les photos/vidéos dans
// le fil du chat. Délai de grâce de 24h après clôture (missions.js, chatAccessExpiresAt) :
// passé ce délai, bloquée entièrement (403) pour client/Œil — contrairement à GET /:id, cette
// route ne sert QUE des médias (rien d'équivalent au reste de la mission à garder accessible),
// un blocage total est donc cohérent ici sans rien casser d'autre. Admin toujours exempté.
router.get('/:missionId', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();

  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1', [req.params.missionId]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  const canView = req.user.role === 'admin'
    || mission.client_id === req.user.id
    || mission.oeil_id === req.user.id;
  if (!canView) return res.status(403).json({ error: 'Accès refusé' });

  if (req.user.role !== 'admin') {
    const expiresAt = chatAccessExpiresAt(mission);
    if (expiresAt !== null && Date.now() > new Date(expiresAt).getTime()) {
      return res.status(403).json({ error: 'Le délai de consultation de cette conversation est dépassé.' });
    }
  }

  const { rows } = await db.query(
    `SELECT m.*, u.first_name||' '||u.last_name AS uploader_name
     FROM mission_media m JOIN users u ON u.id=m.uploader_id
     WHERE m.mission_id=$1 ORDER BY m.created_at DESC`,
    [req.params.missionId]
  );

  res.json({ media: rows });
}));

module.exports = router;