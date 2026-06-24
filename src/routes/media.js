const router = require('express').Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');

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
    const allowed = /jpeg|jpg|png|webp|mp4|mov/;
    if (allowed.test(file.mimetype) || allowed.test(file.originalname)) cb(null, true);
    else cb(new Error('Type de fichier non supporté'));
  }
});

// ── POST /api/media/:missionId ────────────────────────────
router.post('/:missionId', authenticate, upload.array('files', 10), async (req, res) => {
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

  // Notifier le client
  if (inserted.length > 0 && req.user.role === 'oeil') {
    const emitToUser = req.app.get('emitToUser');
    const notifBody = `Votre Œil a envoyé ${inserted.length} ${inserted[0]?.type === 'video' ? 'vidéo(s)' : 'photo(s)'} pour "${mission.title}"`
    await db.query(
      `INSERT INTO notifications (user_id,title,body,type,mission_id) VALUES ($1,$2,$3,'media',$4)`,
      [mission.client_id, '📸 Médias reçus', notifBody, mission.id]
    );
    if (emitToUser) emitToUser(mission.client_id, 'notification', {
      title: '📸 Médias reçus',
      body: notifBody,
      missionId: mission.id
    });
  }

  res.status(201).json({ media: inserted, count: inserted.length });
});

// ── GET /api/media/:missionId ─────────────────────────────
router.get('/:missionId', authenticate, async (req, res) => {
  const db = getDb();

  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1', [req.params.missionId]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  const canView = req.user.role === 'admin'
    || mission.client_id === req.user.id
    || mission.oeil_id === req.user.id;
  if (!canView) return res.status(403).json({ error: 'Accès refusé' });

  const { rows } = await db.query(
    `SELECT m.*, u.first_name||' '||u.last_name AS uploader_name
     FROM mission_media m JOIN users u ON u.id=m.uploader_id
     WHERE m.mission_id=$1 ORDER BY m.created_at DESC`,
    [req.params.missionId]
  );

  res.json({ media: rows });
});

module.exports = router;