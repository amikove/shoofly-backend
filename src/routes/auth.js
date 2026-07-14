const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/schema');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { resolveCity, resolveQuartier } = require('../constants/villes');

const makeToken = (user) => jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
const safe = ({ password, ...u }) => u;

router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('first_name').trim().notEmpty(),
  body('last_name').trim().notEmpty(),
  body('role').isIn(['client','oeil']),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const { email, password, first_name, last_name, role, phone, city, quartier,
          birth_date, profil, usage_reason, usage_frequency, villes_cibles,
          situation, disponibilite, motivation,
          acquisition_source, acquisition_medium, acquisition_campaign } = req.body;
    const { rows: existing } = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.length) return res.status(409).json({ error: 'Email déjà utilisé' });

    let canonicalCity = null;
    if (city) {
      canonicalCity = resolveCity(city);
      if (!canonicalCity) return res.status(400).json({ error: 'Ville invalide' });
    }
    let canonicalQuartier = null;
    if (quartier) {
      if (!canonicalCity) return res.status(400).json({ error: 'Quartier fourni sans ville valide' });
      canonicalQuartier = resolveQuartier(canonicalCity, quartier);
      if (!canonicalQuartier) return res.status(400).json({ error: 'Quartier invalide pour cette ville' });
    }

    const id = uuidv4();
    const { rows: [user] } = await db.query(
    `INSERT INTO users (id,email,password,role,first_name,last_name,phone,city,quartier,
      birth_date,profil,usage_reason,usage_frequency,villes_cibles,situation,disponibilite,motivation,
      acquisition_source,acquisition_medium,acquisition_campaign)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [id, email, bcrypt.hashSync(password, 10), role, first_name, last_name,
     phone||null, canonicalCity, canonicalQuartier, birth_date||null,
     profil||null, usage_reason||null, usage_frequency||null, villes_cibles||null,
     situation||null, disponibilite||null, motivation||null,
     acquisition_source||null, acquisition_medium||null, acquisition_campaign||null]
  );
  if (role === 'oeil') await db.query(`INSERT INTO oeil_profiles (user_id) VALUES ($1)`, [id]);

  await db.query(`INSERT INTO notifications (user_id,title,body,type,action_type,title_key,body_key,params) VALUES ($1,$2,$3,'info','none',$4,$5,$6)`, [
    id, 'Bienvenue sur SHOOFLY 👁️',
    role === 'oeil' ? 'Votre profil sera vérifié sous 24h.' : 'Vous pouvez commander votre première mission.',
    'welcomeTitle',
    role === 'oeil' ? 'welcomeBodyOeil' : 'welcomeBodyClient',
    null
  ]);

  res.status(201).json({ token: makeToken(user), user: safe(user) });
}));

router.post('/login', [
      body('email').isEmail().normalizeEmail(),
      body('password').notEmpty(),
    ], asyncHandler(async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const db = getDb();
      const { rows: [user] } = await db.query('SELECT * FROM users WHERE email=$1', [req.body.email]);
      if (!user || !bcrypt.compareSync(req.body.password, user.password))
        return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      if (!user.is_active) return res.status(403).json({ error: 'Compte suspendu' });

      let profile = null;
      if (user.role === 'oeil') {
        const { rows: [p] } = await db.query('SELECT * FROM oeil_profiles WHERE user_id=$1', [user.id]);
        profile = p;
      }
     if (profile) {
        Object.assign(user, {
          rating_avg:     profile.rating_avg,
          rating_count:   profile.rating_count,
          total_missions: profile.total_missions,
          is_available:   profile.is_available,
          is_verified:    profile.is_verified,
          bio:            profile.bio,
          coverage_zone:  profile.coverage_zone,
        })
      }
      res.json({ token: makeToken(user), user: safe(user), profile });
    }));

router.get('/me', authenticate, asyncHandler(async (req, res) => {
      const db = getDb();
      const { rows: [user] } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
      if (!user) return res.status(404).json({ error: 'Introuvable' });
      let profile = null;
      if (user.role === 'oeil') {
        const { rows: [p] } = await db.query('SELECT * FROM oeil_profiles WHERE user_id=$1', [user.id]);
        profile = p;
      }
    
        if (user.disponibilites && typeof user.disponibilites === 'string') {
          try { user.disponibilites = JSON.parse(user.disponibilites) } catch {}
        }
        if (profile) {
          Object.assign(user, {
            rating_avg:     profile.rating_avg,
            rating_count:   profile.rating_count,
            total_missions: profile.total_missions,
            is_available:   profile.is_available,
            is_verified:    profile.is_verified,
            bio:            profile.bio,
            coverage_zone:  profile.coverage_zone,
          })
        }
        res.json({ user: safe(user), profile });


    }));

router.put('/me', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { first_name, last_name, phone, city, bio, coverage_zone, disponibilites } = req.body;

  let canonicalCity = null;
  if (city) {
    canonicalCity = resolveCity(city);
    if (!canonicalCity) return res.status(400).json({ error: 'Ville invalide' });
  }

  const { rows: [user] } = await db.query(
    `UPDATE users SET
      first_name=COALESCE($1,first_name),
      last_name=COALESCE($2,last_name),
      phone=COALESCE($3,phone),
      city=COALESCE($4,city),
      disponibilites=COALESCE($5,disponibilites),
      updated_at=NOW()
     WHERE id=$6 RETURNING *`,
    [first_name||null, last_name||null, phone||null, canonicalCity,
     disponibilites ? JSON.stringify(disponibilites) : null,
     req.user.id]
  );
  if (req.user.role === 'oeil') {
    await db.query(
      `UPDATE oeil_profiles SET bio=COALESCE($1,bio), coverage_zone=COALESCE($2,coverage_zone) WHERE user_id=$3`,
      [bio||null, coverage_zone||null, req.user.id]
    );
  }

    if (user.disponibilites && typeof user.disponibilites === 'string') {
    try { user.disponibilites = JSON.parse(user.disponibilites) } catch {}
  }
  res.json({ user: safe(user) });


  }));

router.put('/password', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: [user] } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (!bcrypt.compareSync(req.body.current_password, user.password))
    return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  await db.query('UPDATE users SET password=$1, password_changed_at=NOW() WHERE id=$2', [bcrypt.hashSync(req.body.new_password, 10), req.user.id]);
  res.json({ message: 'Mot de passe modifié' });
}));

module.exports = router;
