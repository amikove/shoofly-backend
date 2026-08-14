const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/schema');
const { getSetting } = require('../utils/settings');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { resolveCity, resolveQuartier } = require('../constants/villes');
const { sendPasswordResetEmail } = require('../services/email');
const {
  PROFIL_OPTIONS, SITUATION_OPTIONS, MOTIVATION_OPTIONS,
  USAGE_REASON_OPTIONS, USAGE_FREQUENCY_OPTIONS, DISPONIBILITE_OPTIONS,
} = require('../constants/registrationOptions');

const makeToken = (user) => jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
// password_reset_token_hash/password_reset_expires_at (db/schema.js) strippés ici au même titre
// que password : ce sont des colonnes internes (hash SHA-256 + expiration d'un token de
// réinitialisation), jamais à exposer même à l'utilisateur propriétaire du compte.
const safe = ({ password, password_reset_token_hash, password_reset_expires_at, ...u }) => u;
// SHA-256 hex, PAS bcrypt — voir le commentaire détaillé sur password_reset_token_hash dans
// db/schema.js (bcrypt sale aléatoirement, ce qui rend impossible un lookup par
// `WHERE password_reset_token_hash=$1`; SHA-256 convient précisément parce que le token en
// entrée est déjà à haute entropie, jamais un secret choisi par un humain).
const hashResetToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('first_name').trim().notEmpty(),
  body('last_name').trim().notEmpty(),
  body('role').isIn(['client','oeil']),
  // checkFalsy : le formulaire envoie systématiquement les champs des DEUX rôles (client
  // et oeil), ceux non pertinents pour le rôle choisi arrivant en chaîne vide '' plutôt
  // qu'absents — checkFalsy traite '' comme "non fourni" au lieu de le rejeter.
  body('profil').optional({ checkFalsy: true }).isIn(PROFIL_OPTIONS),
  body('situation').optional({ checkFalsy: true }).isIn(SITUATION_OPTIONS),
  body('motivation').optional({ checkFalsy: true }).isIn(MOTIVATION_OPTIONS),
  body('usage_reason').optional({ checkFalsy: true }).isIn(USAGE_REASON_OPTIONS),
  body('usage_frequency').optional({ checkFalsy: true }).isIn(USAGE_FREQUENCY_OPTIONS),
  body('disponibilite').optional({ checkFalsy: true }).isIn(DISPONIBILITE_OPTIONS),
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
    if (phone) {
      const { rows: existingPhone } = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
      if (existingPhone.length) return res.status(409).json({ error: 'Numéro de téléphone déjà utilisé' });
    }

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
    const { first_name, last_name, phone, city, bio, coverage_zone, disponibilites, has_bank_account } = req.body;
    if (phone) {
      const { rows: existingPhone } = await db.query('SELECT id FROM users WHERE phone=$1 AND id != $2', [phone, req.user.id]);
      if (existingPhone.length) return res.status(409).json({ error: 'Numéro de téléphone déjà utilisé' });
    }
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
    // has_bank_account est tri-state (true / false / jamais répondu) : contrairement à bio et
    // coverage_zone ci-dessus, `false` est une réponse valide qu'il ne faut pas confondre avec
    // "champ non fourni" — le pattern `valeur||null` utilisé pour les champs texte échouerait
    // ici car `false||null` vaut `null` en JS et écraserait silencieusement la réponse.
    const hasBankAccount = typeof has_bank_account === 'boolean' ? has_bank_account : null;
    await db.query(
      `UPDATE oeil_profiles SET bio=COALESCE($1,bio), coverage_zone=COALESCE($2,coverage_zone), has_bank_account=COALESCE($3,has_bank_account) WHERE user_id=$4`,
      [bio||null, coverage_zone||null, hasBankAccount, req.user.id]
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

// Message et code HTTP strictement IDENTIQUES que l'email corresponde à un compte ou non — même
// principe que /login (message générique "Email ou mot de passe incorrect", jamais "email
// inconnu"). La réponse est envoyée sans attendre la fin de l'envoi de l'email (fire-and-forget,
// voir plus bas) : si on l'attendait, le round-trip réseau vers Resend rendrait la branche
// "email existant" mesurablement plus lente que la branche "email inconnu" (qui ne fait qu'un
// SELECT), ce qui serait exactement l'oracle de timing que ce endpoint doit éviter.
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const { rows: [user] } = await db.query('SELECT id, first_name FROM users WHERE email=$1', [req.body.email]);

  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashResetToken(rawToken);
    const passwordResetTokenExpiryHours = await getSetting(db, 'password_reset_token_expiry_hours', 1);
    const expiresAt = new Date(Date.now() + passwordResetTokenExpiryHours * 60 * 60 * 1000);

    // Écrase directement tout token précédent encore valide pour cet utilisateur — l'invariant
    // "dernier token demandé = seul valide" est structurel ici (une seule paire de colonnes par
    // utilisateur), aucun DELETE explicite d'anciens tokens n'est nécessaire (voir db/schema.js).
    await db.query(
      'UPDATE users SET password_reset_token_hash=$1, password_reset_expires_at=$2 WHERE id=$3',
      [tokenHash, expiresAt, user.id]
    );

    // Fire-and-forget délibéré (voir commentaire au-dessus de la route) — sendPasswordResetEmail
    // (services/email.js) ne lance déjà jamais d'erreur (même contrat que sendWhatsAppTemplate),
    // le .catch() ici est un filet de sécurité supplémentaire : une exception non interceptée
    // dans une promesse non attendue deviendrait un unhandledRejection global, qui CRASHE le
    // process entier (voir le handler process.on('unhandledRejection') dans index.js).
    sendPasswordResetEmail(req.body.email, user.first_name, rawToken, passwordResetTokenExpiryHours)
      .catch((err) => console.error('[forgot-password] échec inattendu de l\'envoi email', err?.message));
  }

  res.json({ message: 'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé.' });
}));

router.post('/reset-password', [
  body('token').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const tokenHash = hashResetToken(req.body.token);

  // UPDATE atomique unique plutôt que SELECT puis UPDATE séparés : le WHERE porte à la fois sur
  // le hash ET l'expiration, et RETURNING id dit si une ligne a réellement matché. Ceci rend la
  // consommation du token intrinsèquement à usage unique même sous concurrence — si deux requêtes
  // arrivent avec le même token valide en même temps, Postgres sérialise les deux UPDATE sur la
  // même ligne ; la première gagne et vide password_reset_token_hash, la seconde ne trouve alors
  // plus aucune ligne correspondante (rowCount=0) et échoue proprement, sans fenêtre de double-usage.
  const { rows: [user] } = await db.query(
    `UPDATE users SET
       password=$1,
       password_changed_at=NOW(),
       password_reset_token_hash=NULL,
       password_reset_expires_at=NULL
     WHERE password_reset_token_hash=$2 AND password_reset_expires_at > NOW()
     RETURNING id`,
    [bcrypt.hashSync(req.body.newPassword, 10), tokenHash]
  );

  if (!user) return res.status(400).json({ error: 'Lien invalide ou expiré. Veuillez refaire une demande de réinitialisation.' });

  // password_changed_at vient d'être posé — réutilise le mécanisme d'invalidation JWT déjà en
  // place (middleware/auth.js + revalidation Socket.IO périodique dans index.js) : toute session
  // ouverte avant cet instant (y compris via le mot de passe qu'on vient de remplacer) devient
  // invalide au prochain appel, sans code supplémentaire à écrire ici.
  res.json({ message: 'Mot de passe réinitialisé avec succès.' });
}));

module.exports = router;
