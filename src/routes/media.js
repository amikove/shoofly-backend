const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || './uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|mp4|mov|pdf/;
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.test(ext)) cb(null, true);
    else cb(new Error('Type de fichier non supporté'));
  }
});

// ── POST /media/:missionId ────────────────────────────────
router.post('/:missionId', authenticate, requireRole('oeil', 'admin'), upload.array('files', 10), (req, res) => {
  const db = getDb();
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.missionId);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (req.user.role === 'oeil' && mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (!['active', 'en_route'].includes(mission.status)) return res.status(400).json({ error: 'Mission non active' });

  const inserted = [];
  const insertMedia = db.prepare(`
    INSERT INTO mission_media (mission_id,uploader_id,type,filename,url,size_bytes,caption)
    VALUES (?,?,?,?,?,?,?)
  `);

  for (const file of req.files || []) {
    const isVideo = /mp4|mov/.test(path.extname(file.originalname).toLowerCase());
    const isPdf   = /pdf/.test(path.extname(file.originalname).toLowerCase());
    const type    = isPdf ? 'document' : isVideo ? 'video' : 'photo';
    const url     = `/uploads/${file.filename}`;

    const { lastID } = insertMedia.run(
      mission.id, req.user.id, type, file.filename, url, file.size, req.body.caption || null
    );
    inserted.push(db.prepare('SELECT * FROM mission_media WHERE id=?').get(lastID));
  }

  // Notify client
  db.prepare(`INSERT INTO notifications (user_id,title,body,type,mission_id) VALUES (?,?,?,?,?)`)
    .run(mission.client_id,
      `${inserted.length} ${inserted[0]?.type === 'video' ? 'vidéo(s)' : 'photo(s)'} reçue(s)`,
      `Votre Œil a envoyé des médias pour la mission "${mission.title}"`,
      'media', mission.id
    );

  res.status(201).json({ media: inserted, count: inserted.length });
});

// ── GET /media/:missionId ─────────────────────────────────
router.get('/:missionId', authenticate, (req, res) => {
  const db = getDb();
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.missionId);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  const canView = req.user.role === 'admin'
    || mission.client_id === req.user.id
    || mission.oeil_id === req.user.id;
  if (!canView) return res.status(403).json({ error: 'Accès refusé' });

  const media = db.prepare(`
    SELECT m.*, u.first_name||' '||u.last_name AS uploader_name
    FROM mission_media m JOIN users u ON u.id=m.uploader_id
    WHERE m.mission_id=? ORDER BY m.created_at DESC
  `).all(req.params.missionId);

  res.json({ media });
});

module.exports = router;
