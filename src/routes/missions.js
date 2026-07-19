const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');
const { logReliabilityEvent, computeLatePenalty, isNewOeil } = require('../utils/reliabilityScore');
const { computeAvgResponseMinutesBulk } = require('../utils/responseTime');
const { refundOnCancellation } = require('../utils/refund');
const { getSetting } = require('../utils/settings');
const { logStatus } = require('../utils/missionHistory');
const { transitionMission, MissionTransitionError } = require('../utils/missionStateMachine');
const walletService = require('../services/walletService');
const { sendWhatsAppTemplate } = require('../services/wasel');
const waselTemplates = require('../config/waselTemplates');
const asyncHandler = require('../middleware/asyncHandler');
const { resolveCity, resolveQuartier } = require('../constants/villes');
const { isValidSubcategory } = require('../constants/missionCategories');


async function getCommissionRate(db) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key='commission'")
  return rows.length ? parseFloat(rows[0].value) : 0.20
}

async function pricing(price, db) {
  const rate = await getCommissionRate(db)
  const commission = Math.round(price * rate * 100) / 100;
  return { commission, oeil_earning: price - commission };
}

async function notify(db, userId, title, body, type = 'info', missionId = null, emitToUser = null, actionType = null, titleKey = null, bodyKey = null, params = null) {
  const r = await db.query(
    `INSERT INTO notifications (user_id,title,body,type,mission_id,action_type,title_key,body_key,params) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [userId, title, body, type, missionId, actionType, titleKey, bodyKey, params ? JSON.stringify(params) : null]
  );
  if (emitToUser) emitToUser(userId, 'notification', r.rows[0]);
}

// ── POST /missions/:id/validate ────────────────────────────
router.post('/:id/validate', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (mission.status !== 'completed') return res.status(400).json({ error: 'Mission non terminée' });
  if (mission.validated_at) return res.status(400).json({ error: 'Mission déjà validée' });

  // Toutes les écritures interdépendantes (validated_at, chaîne de transfert, crédit(s)
  // wallet, ledger, historique) dans une seule transaction — avant ce correctif, un crash
  // entre deux de ces étapes pouvait laisser une mission "validée" sans que le paiement
  // correspondant ait été appliqué (ou l'inverse). partialPayments accumule les paiements
  // au prorata pour notifier APRÈS le commit (jamais de notify() dans la transaction).
  const partialPayments = [];
  try {
    await walletService.withTransaction(db, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE missions SET validated_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='completed' AND validated_at IS NULL`,
        [mission.id]
      );
      if (rowCount === 0) {
        const err = new Error('Cette mission a déjà été validée ou a changé de statut entre-temps.');
        err.code = 'STALE';
        throw err;
      }

      if (mission.transfer_type === 'during') {
        // Split au prorata du temps réel de chaque Œil dans la chaîne de transferts —
        // fonctionne peu importe le nombre de transferts (remplace l'ancien split 50/50 figé à 2 Œils).
        await client.query(
          `UPDATE mission_transfer_chain SET ended_at=NOW() WHERE mission_id=$1 AND ended_at IS NULL`,
          [mission.id]
        );
        const { rows: chain } = await client.query(
          `SELECT oeil_id, started_at, ended_at FROM mission_transfer_chain WHERE mission_id=$1 ORDER BY sequence_order ASC`,
          [mission.id]
        );
        if (chain.length > 0) {
          const durations = chain.map(c => Math.max(0, new Date(c.ended_at) - new Date(c.started_at)));
          const totalDuration = durations.reduce((s, d) => s + d, 0);
          for (let i = 0; i < chain.length; i++) {
            const link = chain[i];
            const share = totalDuration > 0
              ? Math.round(mission.oeil_earning * (durations[i] / totalDuration) * 100) / 100
              : Math.round((mission.oeil_earning / chain.length) * 100) / 100; // repli si durées nulles (cas limite)
            await client.query(`UPDATE mission_transfer_chain SET earning_share=$1 WHERE mission_id=$2 AND oeil_id=$3`, [share, mission.id, link.oeil_id]);
            await walletService.credit(client, link.oeil_id, 'oeil', share, 'Part mission — transfert au prorata', mission.id);
            partialPayments.push({ oeilId: link.oeil_id, share });
          }
        } else {
          // Filet de sécurité : transfer_type='during' mais aucune ligne de chaîne trouvée
          // (ne devrait plus arriver avec le nouveau système, mais protège les missions en transition).
          await walletService.credit(client, mission.oeil_id, 'oeil', mission.oeil_earning, 'Mission validée (paiement intégral)', mission.id);
        }
      } else {
        await walletService.credit(client, mission.oeil_id, 'oeil', mission.oeil_earning, 'Validation client', mission.id);
      }

      await logStatus(client, mission.id, 'completed', req.user.id, 'Validée par le client (paiement libéré)');
    });
  } catch (e) {
    if (e.code === 'STALE') return res.status(409).json({ error: e.message });
    throw e;
  }

  // Notifications APRÈS le commit (règle de périmètre des transactions).
  for (const p of partialPayments) {
    await notify(db, p.oeilId, '💰 Paiement partiel reçu', `${p.share} MAD crédités — votre part de "${mission.title}".`, 'info', mission.id, emitToUser, null, 'partialPaymentReceivedTitle', 'partialPaymentReceivedBody', {amount: p.share, missionTitle: mission.title});
  }
  await notify(db, mission.oeil_id, '💰 Paiement reçu !', `Le client a validé "${mission.title}". ${mission.oeil_earning} MAD crédités.`, 'info', mission.id, emitToUser, null, 'paymentReceivedOeilTitle', 'paymentReceivedOeilBody', {missionTitle: mission.title, amount: mission.oeil_earning});
  await notify(db, mission.client_id, '✅ Mission validée', `Vous avez validé "${mission.title}".`, 'info', mission.id, emitToUser, null, 'missionValidatedClientTitle', 'missionValidatedClientBody', {missionTitle: mission.title});

  res.json({ ok: true });
}));


// ── POST /missions/:id/claim ────────────────────────────────
router.post('/:id/claim', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { comment } = req.body;
  if (!comment?.trim()) return res.status(400).json({ error: 'Commentaire obligatoire' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (mission.validated_at) return res.status(400).json({ error: 'Cette mission a déjà été validée, aucune réclamation n\'est plus possible.' });
  if (mission.status !== 'completed') return res.status(400).json({ error: 'Mission non terminée' });

  const clientValidationHours = await getSetting(db, 'client_validation_hours', 12);
  const hoursSinceCompletion = (Date.now() - new Date(mission.completed_by_oeil_at).getTime()) / 3600000;
  if (hoursSinceCompletion > clientValidationHours) return res.status(400).json({ error: `Délai de réclamation dépassé (${clientValidationHours}h)` });

  const emitToUser = req.app.get('emitToUser');


  try {
    await transitionMission(db, mission.id, 'completed', 'sous_reclamation', req.user.id, { note: 'Réclamation client' });
  } catch (e) {
    if (e instanceof MissionTransitionError) return res.status(409).json({ error: e.message });
    throw e;
  }
  await db.query(`INSERT INTO claims (mission_id, client_id, comment) VALUES ($1, $2, $3)`, [req.params.id, req.user.id, comment.trim()]);
  

  // Notifier les admins
  const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin'`);
  for (const admin of admins) {
    await notify(db, admin.id, '🚨 Nouvelle réclamation', `Mission "${mission.title}" contestée par le client.`, 'claim', req.params.id, emitToUser, null, 'newClaimAdminTitle', 'newClaimAdminBody', {missionTitle: mission.title});
  }

  res.json({ ok: true });
}));

// ── GET /missions/:id/history ──────────────────────────────
router.get('/:id/history', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (req.user.role === 'client' && mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (req.user.role === 'oeil' && mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  const { rows } = await db.query(`
    SELECT h.*, u.first_name||' '||u.last_name AS changed_by_name, u.role AS changed_by_role
    FROM mission_status_history h
    LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.mission_id = $1
    ORDER BY h.created_at ASC
  `, [req.params.id]);
  res.json({ history: rows });
}));

// ── GET /missions/inbox ─────────────────────────────────────
router.get('/inbox', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;

  const { rows } = await db.query(`
    SELECT
      m.id, m.title, m.type, m.status,
      c.first_name || ' ' || c.last_name AS client_name,
      o.first_name || ' ' || o.last_name AS oeil_name,
      last_msg.content                   AS last_message,
      last_msg.created_at                AS last_message_at,
      (
        SELECT COUNT(*) FROM mission_messages mm
        WHERE mm.mission_id = m.id
          AND mm.sender_id != $1
          AND mm.created_at > COALESCE(
            (SELECT seen_at FROM mission_chat_seen WHERE user_id=$1 AND mission_id=m.id),
            '1970-01-01'
          )
      )::int AS unread_count
    FROM missions m
    LEFT JOIN users c ON c.id = m.client_id
    LEFT JOIN users o ON o.id = m.oeil_id
    LEFT JOIN LATERAL (
      SELECT content, created_at FROM mission_messages
      WHERE mission_id = m.id
      ORDER BY created_at DESC LIMIT 1
    ) last_msg ON true
    WHERE (m.client_id = $1 OR m.oeil_id = $1)
      AND EXISTS (SELECT 1 FROM mission_messages WHERE mission_id = m.id)
    ORDER BY last_msg.created_at DESC NULLS LAST
  `, [userId]);

  res.json({ inbox: rows });
}));


// ── POST /missions/:id/seen ─────────────────────────────────
router.post('/:id/seen', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  await db.query(`
    INSERT INTO mission_chat_seen (user_id, mission_id, seen_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (user_id, mission_id) DO UPDATE SET seen_at = NOW()
  `, [req.user.id, req.params.id]);
  res.json({ ok: true });
}));


// ── GET /missions ──────────────────────────────────────────
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { status, type, mode, search, page = 1, limit = 20, sort = 'created_desc' } = req.query;
  const offset = (page - 1) * limit;

  const ORDER = {
      created_desc:   'm.created_at DESC',
      created_asc:    'm.created_at ASC',
      scheduled_asc:  'm.scheduled_at ASC NULLS LAST',
      scheduled_desc: 'm.scheduled_at DESC NULLS LAST',
      deadline_asc:   'm.transfer_deadline ASC NULLS LAST',
      deadline_desc:  'm.transfer_deadline DESC NULLS LAST',
      title_asc:      'm.title ASC',
      title_desc:     'm.title DESC',
      client_asc:     'c.first_name ASC, c.last_name ASC',
      client_desc:    'c.first_name DESC, c.last_name DESC',
      oeil_asc:       'o.first_name ASC, o.last_name ASC',
      oeil_desc:      'o.first_name DESC, o.last_name DESC',
      price_asc:      'm.price ASC',
      price_desc:     'm.price DESC',
      status_asc:     'm.status ASC',
      status_desc:    'm.status DESC',
    }
  const orderBy = ORDER[sort] || 'm.created_at DESC';

  let where = [], params = [];
  let p = 1;

  if (req.user.role === 'client') {
    where.push(`m.client_id=$${p++}`); params.push(req.user.id);
  } else if (req.user.role === 'oeil') {
    // Un Œil suspendu ne doit se voir proposer aucune nouvelle mission — l'appel
    // reste autorisé (le middleware ne bloque plus mode='available'), mais on
    // renvoie directement une liste vide sans même construire la requête.
    if (mode === 'available' && req.user.is_suspended) {
      return res.json({ missions: [], total: 0, page: +page, pages: 0 });
    }
// placer les missions ignorées dans une table à part
    if (mode === 'available') {
      where.push(`m.status='pending' AND m.oeil_id IS NULL AND m.city=$${p++}`);
      params.push(req.user.city);

      if (req.query.quartier) {
        where.push(`m.quartier ILIKE $${p++}`);
        params.push(`%${req.query.quartier}%`);
      }

      // Filtre is_priority — une mission passée is_urgent=true (liste de candidats de la
      // cascade épuisée, voir advanceCandidateCascade) reste visible dans le fil par défaut
      // même si is_priority est encore true, exactement comme une mission normale
      // nouvellement publiée (pas de restriction au pool initial, cf. spec réattribution).
      if (req.query.is_priority === 'true') {
        where.push(`m.is_priority=true`);
      } else {
        where.push(`(m.is_priority=false OR m.is_urgent=true)`);
      }

      // Exclure les missions ignorées
      where.push(`m.id NOT IN (SELECT mission_id FROM mission_ignored WHERE oeil_id=$${p++})`);
      params.push(req.user.id);
    }



    
    else {
      where.push(`m.oeil_id=$${p++}`); params.push(req.user.id);
    }
  }
  if (status) { where.push(`m.status=$${p++}`); params.push(status); }
    if (type)   { where.push(`m.type=$${p++}`);   params.push(type); }
    if (search) {
      // Recherche sur : référence (fin de l'id), titre de mission, nom client, nom Œil
      where.push(`(
        m.id::text ILIKE $${p}
        OR m.title ILIKE $${p}
        OR (c.first_name || ' ' || c.last_name) ILIKE $${p}
        OR (o.first_name || ' ' || o.last_name) ILIKE $${p}
      )`);
      params.push(`%${search}%`);
      p++;
    }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';


  const { rows: missions } = await db.query(`
      SELECT m.*,
        c.first_name||' '||c.last_name AS client_name, c.phone AS client_phone, c.avatar_url AS client_avatar,
        o.first_name||' '||o.last_name AS oeil_name,   o.phone AS oeil_phone,   o.avatar_url AS oeil_avatar,
        (SELECT COUNT(*) FROM mission_media WHERE mission_id=m.id)::int AS media_count,
        (SELECT COUNT(*) FROM mission_messages WHERE mission_id=m.id)::int AS message_count,
        (SELECT COUNT(*) FROM mission_interests WHERE mission_id=m.id AND oeil_id='${req.user.id}')::int > 0 AS has_interested,
        (SELECT score FROM ratings WHERE mission_id=m.id LIMIT 1) AS rating_score,
        (SELECT comment FROM ratings WHERE mission_id=m.id LIMIT 1) AS rating_comment,
        (SELECT row_to_json(er) FROM (
          SELECT id, proposed_changes, expires_at, created_at FROM mission_edit_requests
          WHERE mission_id=m.id AND status='pending' LIMIT 1
        ) er) AS pending_edit_request
      FROM missions m
      LEFT JOIN users c ON c.id=m.client_id
      LEFT JOIN users o ON o.id=m.oeil_id
      ${wc}
      ORDER BY ${orderBy}
      LIMIT $${p++} OFFSET $${p++}
    `, [...params, limit, offset]);




  const { rows: [{ n: total }] } = await db.query(`
      SELECT COUNT(*)::int AS n
      FROM missions m
      LEFT JOIN users c ON c.id=m.client_id
      LEFT JOIN users o ON o.id=m.oeil_id
      ${wc}
    `, params);

  missions.forEach(m => {
    if (!(req.user.role === 'admin' || m.oeil_id === req.user.id)) {
      m.client_phone = null;
    }
  });
  res.json({ missions, total, page: +page, pages: Math.ceil(total / limit) });
}));

// ── POST /missions ─────────────────────────────────────────
router.post('/', authenticate, requireRole('client'), [
  body('type').isIn(['immobilier','file_attente','audit','personnalisee']),
  body('title').trim().isLength({ min: 6, max: 200 }),
  body('address').trim().notEmpty(),
  body('city').trim().notEmpty(),
  body('scheduled_at').isISO8601(),
  body('price').isFloat({ min: 0 }),
  body('replacement_preference').optional().isIn(['fast','choose']),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const {
    type, title, description, address, city, quartier, scheduled_at,
    duration_est, price, is_urgent, oeil_id,
    property_type, visit_type, video_call,
    institution, purpose,
    company_name, audit_type, frequency, criteria, subcategory,
    promo_code, discount, original_price, platform_amount,
    replacement_preference,
  } = req.body;

  const canonicalCity = resolveCity(city);
  if (!canonicalCity) return res.status(400).json({ error: 'Ville invalide' });
  let canonicalQuartier = null;
  if (quartier) {
    canonicalQuartier = resolveQuartier(canonicalCity, quartier);
    if (!canonicalQuartier) return res.status(400).json({ error: 'Quartier invalide pour cette ville' });
  }
  if (subcategory && !isValidSubcategory(type, subcategory)) {
    return res.status(400).json({ error: 'Sous-catégorie invalide pour ce type de mission' });
  }

const id = uuidv4();
  let { commission, oeil_earning } = await pricing(+original_price || +price, db);

  // Code promo gratuit — Shoofly paie l'Œil de sa poche. Le code doit être réel, actif,
  // de type 'free', non expiré et pas déjà épuisé par ce client : ne jamais faire confiance
  // au platform_amount envoyé par le client. Avant ce correctif, un client pouvait soumettre
  // n'importe quel promo_code inexistant + price=0 + platform_amount arbitraire et obtenir
  // une dépense réelle fabriquée (constaté empiriquement : 99999 MAD avec un code fictif —
  // audit scénario 9.2). Le montant utilisé est désormais TOUJOURS celui stocké côté serveur
  // sur promo_codes.platform_amount, jamais celui du corps de la requête.
  let freePromo = null;
  if (promo_code && +price === 0) {
    const { rows: [p] } = await db.query(
      `SELECT * FROM promo_codes WHERE UPPER(code)=UPPER($1) AND is_active=true`, [promo_code]
    );
    if (!p || p.type !== 'free') {
      return res.status(400).json({ error: 'Code promo invalide pour une mission gratuite' });
    }
    if (p.expires_at && new Date(p.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Code promo expiré' });
    }
    if (p.max_uses && p.used_count >= p.max_uses) {
      return res.status(400).json({ error: 'Code promo épuisé' });
    }
    const { rows: [usage] } = await db.query(
      `SELECT COUNT(*)::int AS n FROM promo_uses WHERE promo_id=$1 AND user_id=$2`, [p.id, req.user.id]
    );
    if (usage.n >= p.max_uses_per_user) {
      return res.status(400).json({ error: 'Vous avez déjà utilisé ce code' });
    }
    if (!p.platform_amount) {
      return res.status(400).json({ error: "Ce code promo n'a pas de montant configuré" });
    }
    freePromo = p;
    oeil_earning = parseFloat(p.platform_amount);
    commission = 0;
  }

const status = oeil_id ? 'assigned' : 'pending';

const { rows: [mission] } = await db.query(`
  INSERT INTO missions (
    id,client_id,type,subcategory,status,title,description,address,city,quartier,scheduled_at,
    duration_est,price,commission,oeil_earning,is_urgent,
    property_type,visit_type,video_call,institution,purpose,
    company_name,audit_type,frequency,criteria,oeil_id,replacement_preference
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
  RETURNING *
`, [
  id, req.user.id, type, subcategory||null, status, title, description||null, address, canonicalCity, canonicalQuartier,
  new Date(scheduled_at), duration_est||null, price, commission, oeil_earning,
  !!is_urgent, property_type||null, visit_type||null, !!video_call,
  institution||null, purpose||null, company_name||null, audit_type||null,
  frequency||null, criteria||null, oeil_id||null, replacement_preference || 'fast'
]);

// Mission offerte via code promo gratuit : Shoofly paie l'Œil de sa poche, sans commission générée.
// On enregistre ce coût comme une dépense pour qu'il reste visible dans le Dashboard Financier.
// Montant = freePromo.platform_amount (validé côté serveur ci-dessus), jamais une valeur cliente.
if (freePromo) {
  await db.query(
    `INSERT INTO expenses (amount, category, description, expense_date, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [freePromo.platform_amount, 'Promotions', `[Généré automatiquement] Mission offerte "${title}" — code promo ${freePromo.code}`, new Date().toISOString().slice(0, 10), null]
  );
}

await logStatus(db, mission.id, 'pending', req.user.id, 'Mission créée');

// Enregistrer l'utilisation du code promo

  if (promo_code) {
    const { rows: [promo] } = await db.query(
      `SELECT id FROM promo_codes WHERE UPPER(code)=UPPER($1)`, [promo_code]
    );
    if (promo) {
      await db.query(
        `INSERT INTO promo_uses (promo_id, user_id, mission_id, discount) VALUES ($1,$2,$3,$4)`,
        [promo.id, req.user.id, mission.id, discount || 0]
      );
      await db.query(
        `UPDATE promo_codes SET used_count=used_count+1 WHERE id=$1`, [promo.id]
      );
    }
  }

  // Notify verified available oeils, restreint aux Œils de la même ville que la mission
  const { rows: oeils } = await db.query(
    `SELECT u.id FROM users u JOIN oeil_profiles p ON p.user_id=u.id
     WHERE u.role='oeil' AND u.is_active=true AND p.is_verified=true AND p.is_available=true
       AND u.city=$1`,
    [canonicalCity]
  );
  for (const o of oeils) {
    await notify(db, o.id, `Nouvelle mission${is_urgent?' 🚨 URGENTE':''}`,
      `${title} — ${canonicalCity} · ${price} MAD`, 'mission', id, emitToUser, null,
      is_urgent ? 'newMissionUrgentTitle' : 'newMissionAvailableTitle', 'newMissionBody', {missionTitle: title, city: canonicalCity, price});
  }

  // Broadcast to admin room
  io.to('room:admin').emit('new_mission', mission);

  res.status(201).json({ mission });
}));

// ── PUT /missions/:id ── Client modifie sa mission après création ──────────
// Champs modifiables : title, description, address, city, quartier, scheduled_at,
// duration_est, replacement_preference — jamais price/type/subcategory (rejetés en 400
// s'ils sont présents dans le payload, même à valeur identique).
const FORBIDDEN_EDIT_FIELDS = ['price', 'type', 'subcategory'];

// Valide et normalise les champs envoyés pour une modification de mission — réutilise
// resolveCity/resolveQuartier (mêmes règles qu'à la création, voir POST /missions).
// `mission` sert de repli pour résoudre le quartier quand seul le quartier change
// (proposed_changes ne contient que les champs réellement modifiés, pas un patch complet).
function validateMissionEditFields(body, mission) {
  const changes = {};

  if ('title' in body) {
    const title = String(body.title || '').trim();
    if (title.length < 6 || title.length > 200) return { error: 'Titre invalide (6 à 200 caractères)' };
    changes.title = title;
  }
  if ('description' in body) {
    changes.description = body.description ? String(body.description) : null;
  }
  if ('address' in body) {
    const address = String(body.address || '').trim();
    if (!address) return { error: 'Adresse requise' };
    changes.address = address;
  }
  if ('city' in body) {
    const canonicalCity = resolveCity(body.city);
    if (!canonicalCity) return { error: 'Ville invalide' };
    changes.city = canonicalCity;
  }
  if ('quartier' in body) {
    if (body.quartier) {
      const cityForQuartier = changes.city || mission.city;
      const canonicalQuartier = resolveQuartier(cityForQuartier, body.quartier);
      if (!canonicalQuartier) return { error: 'Quartier invalide pour cette ville' };
      changes.quartier = canonicalQuartier;
    } else {
      changes.quartier = null;
    }
  }
  if ('scheduled_at' in body) {
    const date = new Date(body.scheduled_at);
    if (isNaN(date.getTime())) return { error: 'Date/heure invalide' };
    changes.scheduled_at = date;
  }
  if ('duration_est' in body) {
    const duration = body.duration_est === null || body.duration_est === '' ? null : parseInt(body.duration_est, 10);
    if (duration !== null && (isNaN(duration) || duration < 0)) return { error: 'Durée estimée invalide' };
    changes.duration_est = duration;
  }
  if ('replacement_preference' in body) {
    if (!['fast', 'choose'].includes(body.replacement_preference)) return { error: 'Préférence de remplacement invalide' };
    changes.replacement_preference = body.replacement_preference;
  }

  return { changes };
}

// Applique un objet de changements validés sur la mission — réutilisé par l'application
// directe (mission pending) et par l'approbation d'une demande de modification (mission assigned).
async function applyMissionEditChanges(db, missionId, changes) {
  const keys = Object.keys(changes);
  const setClauses = keys.map((k, i) => `${k}=$${i + 1}`);
  const values = keys.map(k => changes[k]);
  const { rows: [updated] } = await db.query(
    `UPDATE missions SET ${setClauses.join(', ')}, updated_at=NOW() WHERE id=$${values.length + 1} RETURNING *`,
    [...values, missionId]
  );
  return updated;
}

router.put('/:id', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');

  const forbidden = FORBIDDEN_EDIT_FIELDS.filter(f => f in req.body);
  if (forbidden.length > 0) {
    return res.status(400).json({ error: `Champs non modifiables après création : ${forbidden.join(', ')}` });
  }

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });

  const { error, changes } = validateMissionEditFields(req.body, mission);
  if (error) return res.status(400).json({ error });
  if (Object.keys(changes).length === 0) return res.status(400).json({ error: 'Aucun champ à modifier' });

  if (mission.status === 'pending') {
    const { rows: [updated] } = await db.query(
      `UPDATE missions SET ${Object.keys(changes).map((k, i) => `${k}=$${i + 1}`).join(', ')}, updated_at=NOW()
       WHERE id=$${Object.keys(changes).length + 1} AND status='pending' RETURNING *`,
      [...Object.values(changes), mission.id]
    );
    if (!updated) return res.status(409).json({ error: 'Cette mission a changé de statut entre-temps, veuillez rafraîchir.' });
    return res.json({ mission: updated, applied: true });
  }

  if (mission.status === 'assigned') {
    const { rows: [pendingRequest] } = await db.query(
      `SELECT id FROM mission_edit_requests WHERE mission_id=$1 AND status='pending'`,
      [mission.id]
    );
    if (pendingRequest) {
      return res.status(409).json({ error: "Une demande de modification est déjà en attente de réponse de l'Œil. Merci d'attendre sa résolution avant d'en soumettre une nouvelle." });
    }

    // Délai réduit si la mission est prévue dans moins de mission_edit_urgent_threshold_hours.
    const editApprovalMinutes = await getSetting(db, 'mission_edit_approval_minutes', 120);
    const editApprovalMinutesUrgent = await getSetting(db, 'mission_edit_approval_minutes_urgent', 30);
    const editUrgentThresholdHours = await getSetting(db, 'mission_edit_urgent_threshold_hours', 4);
    const hoursUntilMission = (new Date(mission.scheduled_at).getTime() - Date.now()) / 3600000;
    const delayMinutes = hoursUntilMission < editUrgentThresholdHours ? editApprovalMinutesUrgent : editApprovalMinutes;
    const expiresAt = new Date(Date.now() + delayMinutes * 60 * 1000);

    const { rows: [editRequest] } = await db.query(
      `INSERT INTO mission_edit_requests (mission_id, requested_by, proposed_changes, status, expires_at)
       VALUES ($1,$2,$3,'pending',$4) RETURNING *`,
      [mission.id, req.user.id, JSON.stringify(changes), expiresAt]
    );

    const delayLabel = delayMinutes >= 60 ? `${delayMinutes / 60}h` : `${delayMinutes}min`;

    await notify(db, mission.oeil_id,
      '✏️ Modification proposée',
      `Le client propose une modification sur "${mission.title}". Vous avez ${delayLabel} pour répondre.`,
      'mission', mission.id, emitToUser, 'mission_view', 'editRequestPendingOeilTitle', 'editRequestPendingOeilBody',
      { missionTitle: mission.title, delayLabel }
    );

    // Test technique API Wasel (WhatsApp) — réutilise le template de test déjà validé ailleurs
    // sur ce projet (seule la réception compte ici, pas le contenu exact). Un vrai template dédié
    // (edit_request_pending) est préparé dans src/config/waselTemplates.js pour un remplacement futur.
    const { rows: [oeilContact] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.oeil_id]);
    if (oeilContact?.phone) {
      await sendWhatsAppTemplate(waselTemplates.edit_proposed_to_oeil.template_name, oeilContact.phone, [mission.title, 'Modification proposée par le client']);
    } else {
      console.warn(`[wasel] Œil ${mission.oeil_id} sans téléphone renseigné — envoi ignoré (edit-request)`);
    }

    return res.status(202).json({
      edit_request: editRequest,
      message: `Votre demande de modification a été envoyée à l'Œil, en attente de réponse (délai : ${delayLabel}).`,
    });
  }

  return res.status(400).json({ error: `Modification impossible pour une mission au statut "${mission.status}"` });
}));

// ── POST /missions/edit-requests/:id/approve ── Œil accepte la modification proposée ──
router.post('/edit-requests/:id/approve', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const { rows: [editRequest] } = await db.query('SELECT * FROM mission_edit_requests WHERE id=$1', [req.params.id]);
  if (!editRequest) return res.status(404).json({ error: 'Demande de modification introuvable' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [editRequest.mission_id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });

  if (editRequest.status !== 'pending') return res.status(400).json({ error: 'Cette demande a déjà été traitée' });
  if (new Date(editRequest.expires_at) < new Date()) return res.status(400).json({ error: 'Le délai de réponse à cette demande est expiré' });

  const { rowCount } = await db.query(
    `UPDATE mission_edit_requests SET status='approved', resolved_at=NOW() WHERE id=$1 AND status='pending'`,
    [editRequest.id]
  );
  if (rowCount === 0) return res.status(409).json({ error: 'Cette demande a changé de statut entre-temps, veuillez rafraîchir.' });

  const updated = await applyMissionEditChanges(db, mission.id, editRequest.proposed_changes);

  await notify(db, mission.client_id,
    '✅ Modification acceptée',
    `L'Œil a accepté votre demande de modification sur "${mission.title}".`,
    'mission', mission.id, emitToUser, 'mission_view', 'editRequestApprovedClientTitle', 'editRequestApprovedClientBody',
    { missionTitle: mission.title }
  );

  const { rows: [clientContact] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.client_id]);
  if (clientContact?.phone) {
    await sendWhatsAppTemplate(waselTemplates.edit_request_approved.template_name, clientContact.phone, [mission.title, 'Modification acceptée par l\'Œil']);
  }

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status: updated.status });
  io.to('room:admin').emit('mission_updated', updated);

  res.json({ mission: updated, edit_request: { ...editRequest, status: 'approved' } });
}));

// ── POST /missions/edit-requests/:id/reject ── Œil refuse la modification proposée ──
// Remise en recherche SANS pénalité : ni logReliabilityEvent, ni remboursement — ce n'est
// ni une annulation ni un abandon, juste un désaccord sur les nouvelles conditions proposées.
router.post('/edit-requests/:id/reject', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const { rows: [editRequest] } = await db.query('SELECT * FROM mission_edit_requests WHERE id=$1', [req.params.id]);
  if (!editRequest) return res.status(404).json({ error: 'Demande de modification introuvable' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [editRequest.mission_id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });

  if (editRequest.status !== 'pending') return res.status(400).json({ error: 'Cette demande a déjà été traitée' });

  const { rowCount } = await db.query(
    `UPDATE mission_edit_requests SET status='rejected', resolved_at=NOW() WHERE id=$1 AND status='pending'`,
    [editRequest.id]
  );
  if (rowCount === 0) return res.status(409).json({ error: 'Cette demande a changé de statut entre-temps, veuillez rafraîchir.' });

  let updatedMission;
  try {
    updatedMission = await transitionMission(db, mission.id, 'assigned', 'pending', req.user.id, {
      extraFields: { oeil_id: null, is_priority: true, transfer_deadline: null },
      note: 'Demande de modification refusée par l\'Œil',
    });
  } catch (e) {
    if (e instanceof MissionTransitionError) return res.status(409).json({ error: e.message });
    throw e;
  }

  await notify(db, mission.client_id,
    'Mission remise en recherche',
    `L'Œil n'a pas pu donner suite à votre demande de modification sur "${mission.title}". Nous recherchons un nouvel Œil, sans frais ni pénalité pour vous.`,
    'mission', mission.id, emitToUser, 'mission_view', 'editRequestRejectedClientTitle', 'editRequestRejectedClientBody',
    { missionTitle: mission.title }
  );

  const { rows: [clientContact] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.client_id]);
  if (clientContact?.phone) {
    await sendWhatsAppTemplate(waselTemplates.edit_request_rejected.template_name, clientContact.phone, [mission.title, 'Mission remise en recherche']);
  }

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status: 'pending' });
  io.to('room:admin').emit('mission_updated', updatedMission);

  res.json({ mission: updatedMission, edit_request: { ...editRequest, status: 'rejected' } });
}));


// ── GET /missions/my-reports — le rapporteur consulte l'historique de ses signalements ──
// IMPORTANT : cette route doit rester déclarée AVANT /:id, sinon Express interprète "my-reports" comme un id de mission
router.get('/my-reports', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`
    SELECT r.*,
      m.title AS mission_title, m.city, m.scheduled_at
    FROM mission_problem_reports r
      JOIN missions m ON m.id = r.mission_id
      WHERE r.reporter_id=$1
      ORDER BY r.created_at DESC
  `, [req.user.id]);

  res.json({ reports: rows });
}));

// ── GET /missions/actions-required — 3 listes d'actions en attente pour le client ──
// IMPORTANT : cette route doit rester déclarée AVANT /:id, sinon Express interprète "actions-required" comme un id de mission
router.get('/actions-required', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  const clientId = req.user.id;
  const clientValidationHours = await getSetting(db, 'client_validation_hours', 12);

  const { rows: to_validate } = await db.query(`
    SELECT id, title, completed_by_oeil_at,
      completed_by_oeil_at + INTERVAL '1 hour' * $1::numeric AS deadline
    FROM missions
    WHERE client_id=$2 AND status='completed' AND validated_at IS NULL
    ORDER BY completed_by_oeil_at ASC
  `, [clientValidationHours, clientId]);

  const { rows: to_rate } = await db.query(`
    SELECT m.id, m.title, m.validated_at,
      o.first_name||' '||o.last_name AS oeil_name
    FROM missions m
    LEFT JOIN users o ON o.id = m.oeil_id
    WHERE m.client_id=$1 AND m.validated_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.mission_id = m.id)
    ORDER BY m.validated_at DESC
  `, [clientId]);

  // Neutralisé : le client n'est plus jamais sollicité pour choisir un remplaçant — la
  // cascade de confirmation séquentielle (advanceCandidateCascade) gère la réattribution
  // entièrement en interne, quelle que soit la cause. replacement_preference='choose' n'a
  // donc plus aucun effet ; la clé de réponse est conservée à [] pour compatibilité avec
  // le frontend existant (shoofly-react), qui reste à nettoyer côté UI séparément.
  const to_choose_replacement = [];

  res.json({ to_validate, to_rate, to_choose_replacement });
}));

// ── GET /missions/campaign/five-star-bonus ── Statut campagne bonus qualité ──
router.get('/campaign/five-star-bonus', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN ('five_star_bonus_active','five_star_bonus_percent')`
  );
  const s = {};
  rows.forEach(r => s[r.key] = r.value);
  res.json({
    active: s.five_star_bonus_active === 'true',
    percent: parseFloat(s.five_star_bonus_percent || '10'),
  });
}));

// ── GET /missions/pending-confirmations ── Confirmations de présence en attente ──
// Alimente la bannière globale côté frontend (affichée peu importe la page tant que la
// liste n'est pas vide) — voir le rapport de session pour le contrat exact. Doit rester
// déclarée AVANT GET /:id ci-dessous, sinon Express interpréterait "pending-confirmations"
// comme un :id (même piège déjà évité par /actions-required et /campaign/five-star-bonus).
router.get('/pending-confirmations', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(`
    SELECT m.id, m.title, m.scheduled_at, m.presence_confirmation_deadline_at,
      c.first_name AS client_first_name, c.last_name AS client_last_name
    FROM missions m
    JOIN users c ON c.id = m.client_id
    WHERE m.oeil_id = $1
      AND m.status = 'assigned'
      AND m.presence_confirmation_requested_at IS NOT NULL
      AND m.presence_confirmed_at IS NULL
    ORDER BY m.presence_confirmation_deadline_at ASC
  `, [req.user.id]);
  res.json({ pending_confirmations: rows });
}));

// ── GET /missions/:id ──────────────────────────────────
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: [mission] } = await db.query(`
    SELECT m.*,
      c.first_name||' '||c.last_name AS client_name, c.phone AS client_phone, c.email AS client_email,
      o.first_name||' '||o.last_name AS oeil_name,   o.phone AS oeil_phone,
      p.rating_avg AS oeil_rating, p.total_missions AS oeil_total_missions,
      (SELECT row_to_json(er) FROM (
        SELECT id, proposed_changes, expires_at, created_at FROM mission_edit_requests
        WHERE mission_id=m.id AND status='pending' LIMIT 1
      ) er) AS pending_edit_request
    FROM missions m
    LEFT JOIN users c ON c.id=m.client_id
    LEFT JOIN users o ON o.id=m.oeil_id
    LEFT JOIN oeil_profiles p ON p.user_id=m.oeil_id
    WHERE m.id=$1
  `, [req.params.id]);

  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (req.user.role === 'client' && mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (req.user.role === 'oeil' && mission.oeil_id !== req.user.id && mission.status !== 'pending') return res.status(403).json({ error: 'Accès refusé' });

  const [{ rows: media }, { rows: messages }, { rows: [report] }, { rows: [rating] }] = await Promise.all([
    db.query('SELECT * FROM mission_media WHERE mission_id=$1 ORDER BY created_at DESC', [req.params.id]),
    db.query(`SELECT mm.*, u.first_name||' '||u.last_name AS sender_name, u.role AS sender_role
              FROM mission_messages mm JOIN users u ON u.id=mm.sender_id
              WHERE mm.mission_id=$1 ORDER BY mm.created_at ASC`, [req.params.id]),
    db.query('SELECT * FROM mission_reports WHERE mission_id=$1', [req.params.id]),
    db.query('SELECT * FROM ratings WHERE mission_id=$1', [req.params.id]),
  ]);

  // Mark messages as read
  await db.query(`UPDATE mission_messages SET is_read=true WHERE mission_id=$1 AND sender_id!=$2`, [req.params.id, req.user.id]);

  // Le client voit le profil d'un tiers (l'Œil assigné) : un débutant (< 10 missions)
  // n'a pas assez d'historique pour qu'une note affichée soit significative.
  // L'Œil consultant sa propre mission et l'admin gardent la vraie valeur.
  if (req.user.role === 'client' && mission.oeil_id) {
    const newOeilThreshold = await getSetting(db, 'new_oeil_mission_threshold', 10);
    mission.is_new_oeil = isNewOeil(mission.oeil_total_missions, newOeilThreshold);
    if (mission.is_new_oeil) mission.oeil_rating = null;
  }

  if (!(req.user.role === 'admin' || mission.oeil_id === req.user.id)) {
      mission.client_phone = null;
      mission.client_email = null;
    }

    res.json({ mission, media, messages, report: report||null, rating: rating||null });
}));

// ── POST /missions/:id/accept ──────────────────────────────



router.post('/:id/accept', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.status !== 'pending') return res.status(400).json({ error: 'Mission plus disponible' });
  if (isBatchLive(mission)) {
    return res.status(400).json({ error: "Cette mission est en phase de sélection de remplaçant, merci de manifester votre intérêt via le bouton dédié plutôt que d'accepter directement." });
  }

  const { rows: [profile] } = await db.query('SELECT is_verified FROM oeil_profiles WHERE user_id=$1', [req.user.id]);
  if (!profile?.is_verified) return res.status(403).json({ error: 'Profil non vérifié' });

  
    // Valeur calculée ici (dépend de is_priority/transferred_from lus juste au-dessus)
    // car transitionMission ne prend que des valeurs statiques, pas des expressions SQL.
    const oeil2Id = (mission.is_priority === true && mission.transferred_from !== null) ? req.user.id : mission.oeil2_id;

    let updated;
    try {
      updated = await transitionMission(db, req.params.id, 'pending', 'assigned', req.user.id, {
        extraFields: {
          oeil_id: req.user.id, oeil2_id: oeil2Id, assigned_at: 'NOW()', is_priority: false, transfer_deadline: null,
          presence_confirmed_at: null, presence_confirmation_requested_at: null, presence_confirmation_deadline_at: null,
          candidate_window_ends_at: null, pending_candidate_id: null, batch_tiebreak_ends_at: null,
        },
        note: 'Acceptée directement par l\'Œil',
      });
    } catch (e) {
      if (e instanceof MissionTransitionError) return res.status(409).json({ error: e.message });
      throw e;
    }

    // Ardoise vierge sur la cascade par lot pour cette mission (même correctif que sur
    // presence_confirmed_at, voir session précédente) : un candidat non retenu ici ne doit
    // jamais réapparaître "déjà confirmé/sollicité" si cette mission repart un jour en pending.
    await db.query(`UPDATE mission_interests SET solicited_at=NULL, confirmed_at=NULL WHERE mission_id=$1`, [updated.id]);

    // Mission issue d'un transfert en cours de route : on ouvre une nouvelle ligne dans la chaîne
    // pour ce nouvel Œil (elle sera fermée à son tour s'il retransfère, ou au moment de la validation finale).
    if (mission.transfer_type === 'during') {
      const { rows: [{ n: nextOrder }] } = await db.query(
        `SELECT COALESCE(MAX(sequence_order), 0) + 1 AS n FROM mission_transfer_chain WHERE mission_id=$1`,
        [updated.id]
      );
      await db.query(
        `INSERT INTO mission_transfer_chain (mission_id, oeil_id, started_at, sequence_order)
         VALUES ($1, $2, NOW(), $3)`,
        [updated.id, req.user.id, nextOrder]
      );
    }

  const { rows: [oeil] } = await db.query('SELECT first_name, last_name FROM users WHERE id=$1', [req.user.id]);
  const oeilName = `${oeil.first_name} ${oeil.last_name}`;

  await notify(db, mission.client_id, 'Œil assigné 👁️', `${oeilName} a accepté "${mission.title}"`, 'mission', mission.id, emitToUser, null, 'oeilAssignedTitle', 'oeilAssignedBody', {oeilName, missionTitle: mission.title});
  await notify(db, req.user.id, 'Mission acceptée', `Vous avez accepté "${mission.title}"`, 'mission', mission.id, emitToUser, null, 'missionAcceptedOeilTitle', 'missionAcceptedOeilBody', {missionTitle: mission.title});

  await db.query(`INSERT INTO mission_messages (mission_id,sender_id,content,type,content_key,params) VALUES ($1,$2,$3,'system',$4,$5)`,
    [mission.id, req.user.id, `${oeil.first_name} a accepté la mission.`, 'oeilAccepted', JSON.stringify({ oeilName: oeil.first_name })]);

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status: 'assigned', oeil_name: oeilName });
  io.to('room:admin').emit('mission_updated', updated);

  res.json({ mission: updated });
}));



// ── GET /:id/interests ── Liste des Œils intéressés ────────
router.get('/:id/interests', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();

  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1', [req.params.id]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  // Seul le client de la mission ou un admin peut voir les intéressés
  if (mission.client_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  const { rows } = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.city, u.avatar_url,
              p.rating_avg, p.rating_count, p.total_missions, p.bio, p.coverage_zone,
              mi.message, mi.created_at as interested_at
       FROM mission_interests mi
       JOIN users u ON u.id = mi.oeil_id
       LEFT JOIN oeil_profiles p ON p.user_id = mi.oeil_id
       WHERE mi.mission_id = $1
          AND mi.oeil_id IS DISTINCT FROM $2
        ORDER BY mi.created_at ASC`,
        [req.params.id, mission.transferred_from]
      );

    // Le client voit des tiers (Œils candidats) : masque la note d'un débutant
    // (< 10 missions) pour ne pas afficher un signal peu significatif.
    // L'admin, qui peut aussi consulter cette liste, garde la vraie valeur.
    // Le temps de réponse moyen est calculé en une seule requête groupée pour
    // tous les candidats (voir computeAvgResponseMinutesBulk) plutôt qu'en boucle.
    const avgResponseByOeil = await computeAvgResponseMinutesBulk(db, rows.map(o => o.id));
    const newOeilThreshold = await getSetting(db, 'new_oeil_mission_threshold', 10);
    const interests = rows.map(o => {
      const is_new_oeil = isNewOeil(o.total_missions, newOeilThreshold);
      const avg_response_minutes = avgResponseByOeil[o.id] ?? null;
      if (req.user.role === 'client' && is_new_oeil) {
        return { ...o, is_new_oeil, rating_avg: null, rating_count: null, avg_response_minutes };
      }
      return { ...o, is_new_oeil, avg_response_minutes };
    });

    res.json({ interests });
  }));



// ── POST /missions/:id/refuse ──────────────────────────────
router.post('/:id/refuse', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const io = req.app.get('io');
  const emitToUser = req.app.get('emitToUser');
  const { ignore } = req.body;
  try {
    if (ignore) {
      // Mission disponible — juste ignorer
      await db.query(
        `INSERT INTO mission_ignored (oeil_id, mission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [req.user.id, req.params.id]
      );
      return res.json({ ok: true });
    }
    // Mission assignée — refuser. Traitée comme les 3 autres causes de réattribution
    // (transfert 'before'/'during', désactivation admin) : is_priority + transfer_deadline
    // (délai de grâce existant, checkTransferDeadlines reste actif en parallèle, inchangé)
    // + déclenchement de la cascade de confirmation séquentielle. transfer_type='before'
    // (jamais 'during' ici : la mission n'a par définition pas encore démarré) → paiement
    // intégral au remplaçant, pas de split.
      const { rows: [missionBefore] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
      if (!missionBefore) return res.status(404).json({ error: 'Mission introuvable' });

      const graceMinutesQueue = await getSetting(db, 'transfer_grace_minutes_queue', 45);
      const graceMinutesOther = await getSetting(db, 'transfer_grace_minutes_other', 60);
      const graceMinutes = missionBefore.type === 'file_attente' ? graceMinutesQueue : graceMinutesOther;
      const transferDeadline = new Date(Date.now() + graceMinutes * 60 * 1000);

      let mission;
      try {
        mission = await transitionMission(db, req.params.id, 'assigned', 'pending', req.user.id, {
          extraFields: {
            oeil_id: null,
            is_priority: true,
            transfer_type: 'before',
            transferred_from: req.user.id,
            transfer_reason: 'Refusée par l\'Œil',
            transfer_deadline: transferDeadline,
          },
          extraGuards: { oeil_id: req.user.id },
          note: 'Refusée par l\'Œil',
        });
      } catch (e) {
        if (e instanceof MissionTransitionError) return res.status(409).json({ error: e.message });
        throw e;
      }

      // Pénalité de fiabilité proportionnelle au délai avant la mission
      const { points: penaltyPoints, reason: penaltyReason, isGrave } = computeLatePenalty(mission.scheduled_at, 'assignée refusée par l\'Œil');
        await logReliabilityEvent(db, req.user.id, mission.id, penaltyPoints, penaltyReason, isGrave);
        // Cooldown : empêche l'Œil d'accepter immédiatement une autre mission après avoir abandonné celle-ci
        const transferCooldownHours = await getSetting(db, 'transfer_cooldown_hours', 4);
        await db.query(
          `UPDATE users SET transfer_cooldown_until=NOW() + INTERVAL '1 hour' * $1::numeric WHERE id=$2`,
          [transferCooldownHours, req.user.id]
        );

        // Retire la propre candidature de l'Œil refusant sur cette mission (même correctif
        // que POST /:id/transfer, cf. bug fantôme audit 2.9) avant de lancer la cascade.
        await db.query(`DELETE FROM mission_interests WHERE mission_id=$1 AND oeil_id=$2`, [mission.id, req.user.id]);
        await advanceCandidateCascade(db, io, emitToUser, mission, {});

        res.json({ mission });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}));




// ── POST /missions/:id/status ──────────────────────────────
router.post('/:id/status', authenticate, [
  body('status').isIn(['en_route','active','completed','cancelled']),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  if (req.user.role === 'oeil' && mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (req.user.role === 'client' && mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });

  // Filtre PROPRE À CETTE ROUTE (distinct de la table centrale de missionStateMachine.js) :
  // limite volontairement le périmètre de cet endpoint générique aux 4 statuts de
  // progression normale. En particulier, exclut sous_reclamation même si la table
  // centrale autorise sous_reclamation -> completed/cancelled ailleurs (via
  // PUT /admin/claims/:missionId/resolve, qui a sa propre logique d'arbitrage et de
  // crédit wallet) — sans ce filtre, un Œil pourrait clôturer lui-même une mission
  // contestée en contournant la résolution admin.
  const allowedFromThisRoute = {
    pending:  ['cancelled'],
    assigned: ['en_route', 'cancelled'],
    en_route: ['active',   'cancelled'],
    active:   ['completed','cancelled'],
  };

  const { status, cancel_reason } = req.body;
  if (!allowedFromThisRoute[mission.status]?.includes(status))
    return res.status(400).json({ error: `Transition invalide: ${mission.status} → ${status}` });

  // Seul l'Œil assigné fait progresser la mission dans le sens normal — le client
  // n'est jamais à l'origine de ces transitions, même s'il est partie prenante.
  // L'annulation reste ouverte à l'Œil et au client, chacun sur ses propres missions.
  if (['en_route', 'active', 'completed'].includes(status)) {
    if (req.user.role !== 'oeil' || mission.oeil_id !== req.user.id) {
      return res.status(403).json({ error: 'Seul l\'Œil assigné peut faire progresser la mission.' });
    }
  }

  // Bloquer si rapport non soumis pour audit ou airbnb
  if (status === 'completed' && req.user.role === 'oeil') {
    const isAudit  = mission.type === 'audit'
    const isAirbnb = mission.subcategory && ['airbnb','booking'].some(s => mission.subcategory.toLowerCase().includes(s.toLowerCase()))
    if (isAudit || isAirbnb) {
      const { rows: [report] } = await db.query(
        `SELECT * FROM airbnb_reports WHERE mission_id=$1 AND submitted=true`,
        [mission.id]
      )
      if (!report) {
        return res.status(400).json({ error: 'Vous devez soumettre le rapport avant de terminer la mission' })
      }
    }
  }

  if (status === 'cancelled' && req.user.role === 'admin' && req.body.refund_percent !== undefined) {
    const hasFinancePermission = req.user.is_super_admin ||
      (Array.isArray(req.user.permissions) && req.user.permissions.includes('finance'));
    if (!hasFinancePermission) {
      return res.status(403).json({ error: 'Permission insuffisante pour fixer un remboursement personnalise (finance requise)' });
    }
  }

  // Champs conditionnels recalculés en JS (transitionMission ne prend que des valeurs
  // statiques par écriture, pas d'expression SQL type CASE WHEN) — équivalent exact
  // du CASE WHEN $1=... précédent, un seul statut cible possible par appel.
  const extraFields = { updated_at: 'NOW()' };
  if (status === 'completed') { extraFields.completed_at = 'NOW()'; extraFields.completed_by_oeil_at = 'NOW()'; }
  if (status === 'cancelled') { extraFields.cancelled_at = 'NOW()'; extraFields.cancel_reason = cancel_reason || null; }
  if (status === 'active') extraFields.started_at = 'NOW()';
  if (['cancelled', 'completed'].includes(status)) extraFields.is_priority = false;
  delete extraFields.updated_at; // déjà géré systématiquement par transitionMission

  // Garde de propriété atomique pour les transitions réservées à l'Œil assigné (le
  // statut seul suffisait jusqu'ici car aucune autre route ne change oeil_id sans
  // changer aussi status — cf. audit ME-002 sur cette fragilité implicite).
  const extraGuards = ['en_route', 'active', 'completed'].includes(status) ? { oeil_id: req.user.id } : {};

  const completedNote = status === 'completed' ? 'Mission terminée par l\'Œil' : null;

  let updated;
  try {
    updated = await transitionMission(db, mission.id, mission.status, status, req.user.id, {
      extraFields,
      extraGuards,
      note: completedNote,
    });
  } catch (e) {
    if (e instanceof MissionTransitionError) {
      const httpStatus = e.code === 'INVALID_TRANSITION' ? 400 : 409;
      return res.status(httpStatus).json({ error: e.message });
    }
    throw e;
  }

  // Démarrage réel de la mission : on ouvre la première ligne de la chaîne de transferts,
  // point de départ indispensable pour calculer un split correct si la mission est transférée
  // 'during' plus tard (la ligne reste simplement inutilisée à la validation sinon). Uniquement
  // si aucune ligne n'existe déjà : un Œil de remplacement a la sienne ouverte par hireOeilCore
  // dès l'embauche — sans cette garde, son passage à 'active' créerait un doublon et le paierait deux fois.
  if (status === 'active') {
    const { rows: [{ n: existingChainRows }] } = await db.query(
      `SELECT COUNT(*)::int AS n FROM mission_transfer_chain WHERE mission_id=$1`,
      [updated.id]
    );
    if (existingChainRows === 0) {
      await db.query(
        `INSERT INTO mission_transfer_chain (mission_id, oeil_id, started_at, sequence_order)
         VALUES ($1, $2, NOW(), 1)`,
        [updated.id, updated.oeil_id]
      );
    }
  }

  // Remboursement en cas d'annulation — dépend de QUI est à l'origine de l'annulation,
  // pas seulement du timing. Le client n'a rien à se reprocher si l'annulation est
  // causée par l'Œil ou décidée par un admin pour une raison hors faute du client. l'admine a quand meme le choix de decider qui est respnsable et le montant
  if (status === 'cancelled') {
    // Pénalité de fiabilité — sans ça, un Œil pouvait annuler directement via ce
    // endpoint pour échapper à la conséquence appliquée sur /refuse et /transfer.
    if (req.user.role === 'oeil') {
      const { points, reason, isGrave } = computeLatePenalty(mission.scheduled_at, 'annulée par l\'Œil');
      await logReliabilityEvent(db, req.user.id, mission.id, points, reason, isGrave);
    }
    let refund;
    // Un admin peut fixer un pourcentage de remboursement précis, en dérogation à la règle automatique
    // (permission déjà vérifiée plus haut, avant l'UPDATE, pour ne jamais annuler sans pouvoir rembourser)
    if (req.user.role === 'admin' && req.body.refund_percent !== undefined) {
      const pct = Math.max(0, Math.min(parseFloat(req.body.refund_percent) || 0, 100));
      refund = Math.round(mission.price * pct / 100 * 100) / 100;
      if (refund > 0) {
        await db.query(`UPDATE users SET balance=balance+$1 WHERE id=$2`, [refund, mission.client_id]);
        await db.query(
          `INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'credit',$2,$3,$4)`,
          [mission.client_id, refund, 'Remboursement — montant fixé par l\'administrateur', mission.id]
        );
      }
      await notify(db, mission.client_id, '💰 Remboursement', `${refund} MAD crédités sur votre portefeuille suite à l'annulation de "${mission.title}".`, 'info', mission.id, emitToUser, null, 'fullRefundTitle', 'fullRefundBody', {amount: refund});
      if (mission.oeil_id) {
        await notify(db, mission.oeil_id, 'Mission annulée', `La mission "${mission.title}" a été annulée.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledByClientBody', {missionTitle: mission.title});
      }
    } else {
      // Le client est traité comme "à l'origine" de l'annulation dans 2 cas :
      // 1) c'est lui-même qui annule, 2) un admin annule en précisant que la faute lui revient
      const initiatedByClient = req.user.role === 'client'
        || (req.user.role === 'admin' && req.body.client_at_fault === true);
      refund = await refundOnCancellation(db, mission, initiatedByClient);

    if (initiatedByClient) {
      if (!mission.oeil_id) {
        await notify(db, mission.client_id, '💰 Remboursement intégral', `${refund} MAD crédités sur votre portefeuille.`, 'info', mission.id, emitToUser, null, 'fullRefundTitle', 'fullRefundBody', {amount: refund});
      } else if (refund > 0) {
        await notify(db, mission.client_id, '💰 Remboursement partiel', `${refund} MAD crédités sur votre portefeuille suite à l'annulation.`, 'info', mission.id, emitToUser, null, 'partialRefundTitle', 'partialRefundBody', {amount: refund});
      } else {
        await notify(db, mission.client_id, 'Mission annulée', `Annulation dans les 2h — aucun remboursement conformément aux CGV.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledNoRefundBody', null);
      }
      if (mission.oeil_id) {
        await notify(db, mission.oeil_id, 'Mission annulée', `La mission "${mission.title}" a été annulée par le client.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledByClientBody', {missionTitle: mission.title});
      }
    } else {
      await notify(db, mission.client_id, '💰 Remboursement intégral', `${refund} MAD crédités sur votre portefeuille suite à l'annulation de "${mission.title}".`, 'info', mission.id, emitToUser, null, 'fullRefundTitle', 'fullRefundBody', {amount: refund});
      if (mission.oeil_id && mission.oeil_id !== req.user.id) {
        await notify(db, mission.oeil_id, 'Mission annulée', `La mission "${mission.title}" a été annulée.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledByClientBody', {missionTitle: mission.title});
      }
    }
    }

    // Fermer automatiquement tout signalement encore ouvert lié à cette mission —
    // la mission étant annulée, le problème signalé est désormais sans objet.
    await db.query(
      `UPDATE mission_problem_reports SET status='resolved', admin_note=COALESCE(admin_note, 'Résolu automatiquement suite à l''annulation de la mission'), resolved_by=$1, resolved_at=NOW()
         WHERE mission_id=$2 AND status IN ('open','in_progress')`,
      [req.user.id, mission.id]
    );
    await db.query(`UPDATE missions SET under_surveillance=false WHERE id=$1`, [mission.id]);
  }
// Oeil marque terminée → démarrer le délai de 12h pour réclamation

  if (status === 'completed' && mission.oeil_id) {
    await db.query(
      `UPDATE oeil_profiles SET total_missions=total_missions+1 WHERE user_id=$1`,
      [mission.oeil_id]
    );
    await notify(db, mission.client_id, 'Mission terminée ✅', `"${mission.title}" est terminée. Vous avez 12h pour réclamer si nécessaire.`, 'mission', mission.id, emitToUser, null, 'missionCompletedClientTitle', 'missionCompletedClientBody', {missionTitle: mission.title});
    await notify(db, mission.oeil_id, 'Mission terminée', `"${mission.title}" marquée comme terminée. Paiement en attente de validation.`, 'mission', mission.id, emitToUser, null, 'missionCompletedOeilTitle', 'missionCompletedOeilBody', {missionTitle: mission.title});

    // Test technique API Wasel (WhatsApp) — envoie sur le numéro personnel du client.
    // Variables {{1}}, {{2}} : nom de l'Œil et titre de la mission (contexte le plus pertinent pour le client à ce stade).
    const { rows: [clientContact] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.client_id]);
    if (clientContact?.phone) {
      const { rows: [oeilContact] } = await db.query('SELECT first_name, last_name FROM users WHERE id=$1', [mission.oeil_id]);
      const oeilName = oeilContact ? `${oeilContact.first_name} ${oeilContact.last_name}`.trim() : 'Œil';
      await sendWhatsAppTemplate(waselTemplates.mission_completed_client.template_name, clientContact.phone, [oeilName, mission.title]);
    } else {
      console.warn(`[wasel] Client ${mission.client_id} sans téléphone renseigné — envoi ignoré (completed)`);
    }
  }
  



  const labels = { en_route:'en route', active:'démarrée', cancelled:'annulée', completed:'complétée' };
  const sysMsg = { en_route:"L'Œil est en route.", active:"Mission démarrée.", completed:"Mission terminée avec succès.", cancelled:"Mission annulée." };
  const sysMsgKey = { en_route:'missionEnRoute', active:'missionStarted', completed:'missionCompleted', cancelled:'missionCancelled' };

  await db.query(`INSERT INTO mission_messages (mission_id,sender_id,content,type,content_key) VALUES ($1,$2,$3,'system',$4)`,
    [mission.id, req.user.id, sysMsg[status], sysMsgKey[status]]);

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status });
  io.to('room:admin').emit('mission_updated', updated);

  res.json({ mission: updated });
}));

// ── POST /missions/:id/location ────────────────────────────
router.post('/:id/location', authenticate, requireRole('oeil'), [
  body('lat').isFloat({ min: -90, max: 90 }),
  body('lng').isFloat({ min: -180, max: 180 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const { lat, lng } = req.body;
  await db.query(
    `UPDATE missions SET oeil_lat=$1, oeil_lng=$2, oeil_location_at=NOW() WHERE id=$3 AND oeil_id=$4`,
    [lat, lng, req.params.id, req.user.id]
  );
  // Also broadcast via socket
  req.app.get('io').to(`mission:${req.params.id}`).emit('location_update', { lat, lng, timestamp: new Date() });
  res.json({ lat, lng });
}));

// ── POST /missions/:id/report ──────────────────────────────
router.post('/:id/report', authenticate, requireRole('oeil','admin'), [
  body('summary').trim().isLength({ min: 10 }),
  body('score').isInt({ min: 0, max: 100 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (req.user.role === 'oeil' && mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });

  const { summary, risk_points = [], score, notes } = req.body;
  const { rows: [report] } = await db.query(`
    INSERT INTO mission_reports (mission_id,summary,risk_points,score,notes,created_by)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (mission_id) DO UPDATE
    SET summary=$2, risk_points=$3, score=$4, notes=$5
    RETURNING *
  `, [mission.id, summary, JSON.stringify(risk_points), score, notes||null, req.user.id]);

  await notify(db, mission.client_id, '📄 Rapport disponible', `Le rapport de "${mission.title}" est prêt.`, 'report', mission.id, emitToUser, null, 'reportAvailableTitle', 'reportAvailableBody', {missionTitle: mission.title});

  res.status(201).json({ report });
}));


// ── POST /:id/messages ─────────────────────────────────
router.post('/:id/messages', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Message vide' });

  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1', [req.params.id]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  // Vérifier que l'utilisateur est client ou oeil de cette mission
  const isClient = mission.client_id === req.user.id;
  const isOeil   = mission.oeil_id   === req.user.id;
  const isAdmin  = req.user.role === 'admin';
  if (!isClient && !isOeil && !isAdmin) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

const cleanContent = content.trim()

// Détection de contenu sensible
function detectSensitiveContent(text) {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[.\-_\/\\|]/g, '')
    .replace(/zero/g, '0').replace(/zéro/g, '0')
    .replace(/un/g, '1').replace(/deux/g, '2')
    .replace(/trois/g, '3').replace(/quatre/g, '4')
    .replace(/cinq/g, '5').replace(/six/g, '6')
    .replace(/sept/g, '7').replace(/huit/g, '8')
    .replace(/neuf/g, '9')

  const patterns = [
    /0[567]\d{8}/,
    /\+212\d{9}/,
    /\d{10}/,
    /@(gmail|hotmail|yahoo|outlook|live|icloud)/,
    /(whatsapp|telegram|instagram|facebook|tiktok|snapchat|signal)/,
    /(http|www\.|\.com|\.ma|\.net|\.org)/,
  ]
  return patterns.some(p => p.test(normalized))
}

const isFlagged = detectSensitiveContent(cleanContent)

const { rows: [msg] } = await db.query(
  `INSERT INTO mission_messages (mission_id, sender_id, content, type, is_flagged)
   VALUES ($1, $2, $3, 'text', $4) RETURNING *`,
  [req.params.id, req.user.id, cleanContent, isFlagged]
);

// Notifier l'admin si message suspect
if (isFlagged) {
  const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin'`)
  const sender = await db.query('SELECT first_name, last_name FROM users WHERE id=$1', [req.user.id])
  const senderName = `${sender.rows[0]?.first_name} ${sender.rows[0]?.last_name}`
  for (const admin of admins) {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
       VALUES ($1, $2, $3, 'warning', $4, 'admin_messages_suspects', $5, $6, $7)`,
      [admin.id, '⚠️ Message suspect détecté',
       `${senderName} a peut-être partagé un contact externe dans la mission "${mission.title}"`,
       req.params.id,
       'suspiciousMessageAdminTitle', 'suspiciousMessageAdminBody', JSON.stringify({senderName, missionTitle: mission.title})]
    )
    const emitToUser = req.app.get('emitToUser')
    if (emitToUser) emitToUser(admin.id, 'notification', {
      title: '⚠️ Message suspect détecté',
      body: `${senderName} — mission "${mission.title}"`,
      missionId: req.params.id
    })
  }
}

  // Notifier via Socket.io
  const io = req.app.get('io');
  if (io) {
    io.to(`mission:${req.params.id}`).emit('new_message', {
      ...msg,
      sender_role: req.user.role,
    });
  }
// Notification à l'autre partie
  const recipientId = req.user.id === mission.client_id 
    ? mission.oeil_id 
    : mission.client_id;

  if (recipientId) {
    const notifBody = `${mission.title} : ${content.trim().slice(0, 60)}`
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
      VALUES ($1, 'Nouveau message', $2, 'message', $3, 'chat', $4, $5, $6)`,
      [recipientId, notifBody, req.params.id, 'newMessageMissionTitle', null, null]
    );
    const emitToUser = req.app.get('emitToUser');
    if (emitToUser) {
      emitToUser(recipientId, 'notification', {
        title: 'Nouveau message',
        body: notifBody,
        missionId: req.params.id
      });
    }
  }
  res.status(201).json({ message: msg });
}));

router.post('/:id/rate', authenticate, requireRole('client'), [
  body('score').isInt({ min: 1, max: 5 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (mission.status !== 'completed') return res.status(400).json({ error: 'Mission non complétée' });

  const existing = await db.query('SELECT id FROM ratings WHERE mission_id=$1', [req.params.id]);
  if (existing.rows.length) return res.status(409).json({ error: 'Déjà noté' });

  const { nps_facilite, nps_reactivite, nps_utilite, nps_recommandation, platform_comment } = req.body;
    await db.query(
      `INSERT INTO ratings (mission_id,client_id,oeil_id,score,comment,
        nps_facilite,nps_reactivite,nps_utilite,nps_recommandation,platform_comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [mission.id, req.user.id, mission.oeil_id, req.body.score, req.body.comment||null,
       nps_facilite||null, nps_reactivite||null, nps_utilite||null, nps_recommandation||null, platform_comment||null]
    );

  const { rows: [avg] } = await db.query('SELECT AVG(score)::numeric(3,1) AS a, COUNT(*)::int AS c FROM ratings WHERE oeil_id=$1', [mission.oeil_id]);
  await db.query('UPDATE oeil_profiles SET rating_avg=$1, rating_count=$2 WHERE user_id=$3', [avg.a, avg.c, mission.oeil_id]);

  const { rows: [oeilProfile] } = await db.query('SELECT total_missions FROM oeil_profiles WHERE user_id=$1', [mission.oeil_id]);
  const newOeilThreshold = await getSetting(db, 'new_oeil_mission_threshold', 10);
  const is_new_oeil = isNewOeil(oeilProfile?.total_missions, newOeilThreshold);

await notify(db, mission.oeil_id, `Nouvelle note: ${req.body.score}/5 ⭐`, `"${mission.title}" notée par un client.`, 'rating', mission.id, emitToUser, null, 'newRatingTitle', 'newRatingBody', {score: req.body.score, missionTitle: mission.title});

  // Score de fiabilité selon la note
  const score = req.body.score;
  let points, reason;
  if (score >= 4) { points = 10; reason = `Mission complétée, note ${score}/5`; }
  else if (score === 3) { points = 5; reason = `Mission complétée, note 3/5`; }
  else { points = 0; reason = `Mission complétée, note ${score}/5 — insatisfaisant`; }
  await logReliabilityEvent(db, mission.oeil_id, mission.id, points, reason, score <= 2);

  // Bonus qualité "5 étoiles" — campagne marketing activable, indépendante du score de fiabilité ci-dessus.
  if (score === 5) {
    const { rows: bonusSettings } = await db.query(
      `SELECT key, value FROM settings WHERE key IN ('five_star_bonus_active','five_star_bonus_percent')`
    );
    const bs = {};
    bonusSettings.forEach(r => bs[r.key] = r.value);
    if (bs.five_star_bonus_active === 'true') {
      const percent = parseFloat(bs.five_star_bonus_percent || '10');
      const bonus = Math.round(parseFloat(mission.oeil_earning) * (percent / 100) * 100) / 100;
      if (bonus > 0) {
        await walletService.withTransaction(db, async (client) => {
          await walletService.credit(client, mission.oeil_id, 'oeil', bonus, 'Bonus qualité — note 5 étoiles', mission.id);
          await client.query(
            `INSERT INTO expenses (amount, category, description, expense_date, created_by) VALUES ($1, $2, $3, $4, $5)`,
            [bonus, 'Marketing', `[Généré automatiquement] Bonus qualité 5 étoiles — mission "${mission.title}"`, new Date().toISOString().slice(0, 10), null]
          );
        });
        await notify(db, mission.oeil_id, `Bonus qualité 5 étoiles 🎁`, `+${bonus} MAD de bonus pour "${mission.title}" — merci pour votre excellent travail !`, 'bonus', mission.id, emitToUser, null, 'fiveStarBonusTitle', 'fiveStarBonusBody', { amount: bonus, missionTitle: mission.title });
      }
    }
  }

  res.status(201).json({
    rating_avg: is_new_oeil ? null : avg.a,
    rating_count: is_new_oeil ? null : avg.c,
    is_new_oeil,
  });
}));

// ── POST /:id/interest ── Œil exprime son intérêt ─────────

router.post('/:id/interest', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
    const db = getDb();
    const { message } = req.body;
    // La suspension est vérifiée en amont par le middleware authenticate ; le cooldown
    // de transfert reste à vérifier ici, ce n'est pas la même chose qu'une suspension.
    const { rows: [oeilUser] } = await db.query('SELECT transfer_cooldown_until FROM users WHERE id=$1', [req.user.id]);
    if (oeilUser?.transfer_cooldown_until && new Date(oeilUser.transfer_cooldown_until) > new Date()) {
      const remaining = Math.ceil((new Date(oeilUser.transfer_cooldown_until) - Date.now()) / 3600000);
      return res.status(403).json({ error: `Vous ne pouvez pas postuler pendant encore ${remaining}h suite à un transfert de mission.` });
    }
    const { rows: [mission] } = await db.query(
      'SELECT * FROM missions WHERE id=$1', [req.params.id]
    );
    if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
    if (mission.status !== 'pending') return res.status(400).json({ error: 'Mission non disponible' });

  // Vérifier les conflits de créneau
  const scheduleConflictWindowHours = await getSetting(db, 'schedule_conflict_window_hours', 4);
  const { rows: conflicts } = await db.query(`
    SELECT m.id, m.title, m.scheduled_at FROM missions m
    WHERE m.oeil_id = $1
      AND m.status IN ('assigned','en_route','active')
      AND ABS(EXTRACT(EPOCH FROM (m.scheduled_at - $2)) / 3600) < $3::numeric
  `, [req.user.id, mission.scheduled_at, scheduleConflictWindowHours])

  if (conflicts.length > 0) {
    return res.status(400).json({ error: 'Vous avez déjà une mission dans le même créneau.' })
  }

  await db.query(
    `INSERT INTO mission_interests (mission_id, oeil_id, message)
     VALUES ($1, $2, $3) ON CONFLICT (mission_id, oeil_id) DO NOTHING`,
    [req.params.id, req.user.id, message || null]
  );

  const emitToUser = req.app.get('emitToUser');
    const notifBody = `Un Œil est intéressé par votre mission : ${mission.title}`
    await notify(db, mission.client_id, 'Nouvel Œil intéressé 👁️', notifBody, 'interest', req.params.id, emitToUser, 'interests_modal', 'newOeilInterestTitle', 'newOeilInterestBody', {missionTitle: mission.title});
    // Notifie aussi le client par WhatsApp — gratuit s'il a lui-même initié la conversation
    // (bouton wa.me proposé à la création de sa mission).
    const { rows: [clientContact] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.client_id]);
    if (clientContact?.phone) {
      sendWhatsAppTemplate(waselTemplates.oeil_applied.template_name, clientContact.phone, ['Un Œil', mission.title]);
    }

    // Relance la cascade de confirmation par lot si cette mission est en recherche élargie
    // (is_urgent, liste initiale épuisée) et qu'aucun lot n'est actuellement en cours (ni
    // fenêtre de lot, ni fenêtre de départage) — cette nouvelle candidature réactive le
    // mécanisme (voir point 8 de la spec réattribution / advanceCandidateCascade).
    if (mission.is_urgent && !isBatchLive(mission)) {
      const io = req.app.get('io');
      await advanceCandidateCascade(db, io, emitToUser, mission, {});
    }

    res.status(201).json({ ok: true });
}));




// ── POST /missions/:id/transfer ── Œil signale empêchement ──
router.post('/:id/transfer', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');
  const { reason } = req.body;

  if (!reason) return res.status(400).json({ error: 'La raison est obligatoire' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (!['assigned','en_route','active'].includes(mission.status)) {
    return res.status(400).json({ error: 'Transfert impossible pour ce statut' });
  }

  const transferType = mission.status === 'assigned' ? 'before' : 'during';

  // Délai de grâce selon type de mission
  const graceMinutesQueue = await getSetting(db, 'transfer_grace_minutes_queue', 45);
  const graceMinutesOther = await getSetting(db, 'transfer_grace_minutes_other', 60);
  const graceMinutes = mission.type === 'file_attente' ? graceMinutesQueue : graceMinutesOther;
  const deadline = new Date(Date.now() + graceMinutes * 60 * 1000);

  // Remettre la mission en pending avec flag priorité — vérifié et appliqué
  // avant de toucher au compte de l'Œil, pour ne pas lui imputer un cooldown
  // si la mission a en fait déjà changé de statut entre-temps. La sélection du
  // remplaçant est désormais entièrement gérée par advanceCandidateCascade (appelée
  // plus bas) — replacement_preference n'est plus lu ici (neutralisé, contenu ignoré).
  try {
    await transitionMission(db, mission.id, mission.status, 'pending', req.user.id, {
      extraFields: {
        is_priority: true,
        transfer_type: transferType,
        transferred_from: req.user.id,
        transfer_reason: reason,
        transfer_deadline: deadline,
        oeil_id: null,
      },
      extraGuards: { oeil_id: req.user.id },
      note: `Empêchement signalé par l'Œil (${transferType === 'before' ? 'avant démarrage' : 'en cours de mission'})`,
    });
  } catch (e) {
    if (e instanceof MissionTransitionError) return res.status(409).json({ error: e.message });
    throw e;
  }

  // Supprime la propre candidature de l'Œil sur cette mission — sans ça, sa ligne
  // mission_interests (posée avant son embauche initiale) reste éligible et le cron de
  // sélection automatique (index.js, */2min) peut le réassigner lui-même à la mission
  // qu'il vient de signaler ne pas pouvoir honorer. Pour un transfert 'during', le cooldown
  // posé plus bas masque l'effet par accident ; pour 'before' (aucun cooldown posé), rien
  // d'autre ne l'empêchait — bug constaté empiriquement (audit scénario 2.9).
  await db.query(`DELETE FROM mission_interests WHERE mission_id=$1 AND oeil_id=$2`, [mission.id, req.user.id]);

// Transfert pendant mission : ferme la ligne active de la chaîne (le nouvel Œil n'est pas
    // encore connu à ce stade — la nouvelle ligne sera ouverte au moment où quelqu'un accepte
    // effectivement cette mission remise en file prioritaire).
    if (transferType === 'during') {
      await db.query(
        `UPDATE mission_transfer_chain SET ended_at=NOW() WHERE mission_id=$1 AND ended_at IS NULL`,
        [mission.id]
      );
    }
    // Cooldown si transfert pendant mission
    if (transferType === 'during') {
      const transferCooldownHours = await getSetting(db, 'transfer_cooldown_hours', 4);
      await db.query(
        `UPDATE users SET transfer_cooldown_until=NOW() + INTERVAL '1 hour' * $2::numeric, transfer_count=transfer_count+1 WHERE id=$1`,
        [req.user.id, transferCooldownHours]
      );
    } else {
    await db.query(
      `UPDATE users SET transfer_count=transfer_count+1 WHERE id=$1`,
      [req.user.id]
    );
  }

// Pénalité fiabilité — sera recalculée précisément si pas de remplaçant (cron)
  if (transferType === 'before') {
    await logReliabilityEvent(db, req.user.id, mission.id, 5, 'Transfert avant démarrage avec remplaçant', false);
  }


  // Notifications
  await notify(db, mission.client_id,
    '⚠️ Changement sur votre mission',
    `Votre Œil a signalé un empêchement pour "${mission.title}". Nous recherchons un remplaçant en urgence.`,
    'mission', mission.id, emitToUser, null, 'missionChangeAlertTitle', 'missionChangeAlertBody', {missionTitle: mission.title}
  );

  // Message système dans le chat
  await db.query(
    `INSERT INTO mission_messages (mission_id,sender_id,content,type,content_key) VALUES ($1,$2,$3,'system',$4)`,
    [mission.id, req.user.id, `L'Œil a signalé un empêchement. Mission remise en priorité.`, 'missionImpediment']
  );

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status: 'pending' });
  io.to('room:admin').emit('mission_updated', { id: mission.id, is_priority: true });

  // Lance la cascade de confirmation séquentielle sur le pool actuel de mission_interests
  // (l'intérêt propre de l'Œil transférant a déjà été supprimé ci-dessus).
  await advanceCandidateCascade(db, io, emitToUser, mission, {});

  res.json({ ok: true, transfer_type: transferType, deadline });
}));

// ── POST /missions/:id/confirm-presence ── L'Œil confirme sa présence ──
// Confirmation active demandée au rappel J-1 20h ou, à défaut (mission assignée le jour
// même), au rappel H-2 (voir index.js + checkPresenceConfirmationDeadlines ci-dessous).
// Idempotent : si déjà confirmée, renvoie succès sans erreur ni re-déclenchement (COALESCE).
// N'exige pas qu'une demande active existe déjà (presence_confirmation_requested_at) — un
// Œil peut confirmer par anticipation ; les crons J-1/H-2 sautent alors la mission (déjà
// confirmée) sans jamais renvoyer de sollicitation ni poser de deadline.
// Seul l'Œil actuellement assigné peut confirmer : si un remplacement a déjà été déclenché
// (checkPresenceConfirmationDeadlines a retiré l'Œil, oeil_id a changé ou est redevenu NULL),
// cette vérification rejette naturellement toute confirmation tardive de l'Œil d'origine —
// voir le rapport de session pour la nuance sur ce cas (point f de la spec).
router.post('/:id/confirm-presence', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const io = req.app.get('io');

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.oeil_id !== req.user.id) {
    return res.status(403).json({ error: "Vous n'êtes pas (ou plus) l'Œil assigné à cette mission." });
  }

  const { rows: [updated] } = await db.query(
    `UPDATE missions SET presence_confirmed_at = COALESCE(presence_confirmed_at, NOW())
     WHERE id=$1 AND oeil_id=$2 RETURNING presence_confirmed_at`,
    [mission.id, req.user.id]
  );

  if (io) io.to('room:admin').emit('mission_updated', { id: mission.id, presence_confirmed_at: updated.presence_confirmed_at });

  res.json({ ok: true, presence_confirmed_at: updated.presence_confirmed_at });
}));

// ── POST /missions/:id/assign-admin ── Admin affecte manuellement ──
router.post('/:id/assign-admin', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
    const db = getDb();
    const emitToUser = req.app.get('emitToUser');
    const io = req.app.get('io');
    const { oeil_id, override_warning } = req.body;
    if (!oeil_id) return res.status(400).json({ error: 'oeil_id requis' });
    const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
    if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
    if (!['pending'].includes(mission.status)) return res.status(400).json({ error: 'Mission non disponible pour affectation' });
    // Capturé avant l'écrasement des champs de cascade plus bas (transitionMission + nettoyage
    // mission_interests) — reflète l'état au moment de l'appel, jamais bloquant (décision produit :
    // l'admin doit toujours pouvoir écraser une cascade en cours).
    const cascadeInterrupted = isBatchLive(mission);
    // Vérifier que l'Œil est vérifié et disponible
    const { rows: [profile] } = await db.query(
      `SELECT is_verified, is_available FROM oeil_profiles WHERE user_id=$1`, [oeil_id]
    );
    if (!profile?.is_verified) return res.status(400).json({ error: 'Œil non vérifié' });
    // Suspension/cooldown : bloqué par défaut, mais l'admin peut passer outre avec confirmation explicite
    const { rows: [oeilStatus] } = await db.query('SELECT is_suspended, transfer_cooldown_until FROM users WHERE id=$1', [oeil_id]);
    const hasCooldown = oeilStatus?.transfer_cooldown_until && new Date(oeilStatus.transfer_cooldown_until) > new Date();
    if ((oeilStatus?.is_suspended || hasCooldown) && !override_warning) {
      const reasons = [];
      if (oeilStatus?.is_suspended) reasons.push('cet Œil est actuellement suspendu');
      if (hasCooldown) {
        const remaining = Math.ceil((new Date(oeilStatus.transfer_cooldown_until) - Date.now()) / 3600000);
        reasons.push(`cet Œil est en cooldown pour encore ${remaining}h suite à un transfert de mission`);
      }
      return res.status(409).json({
        error: `Attention : ${reasons.join(' et ')}. Confirmez pour affecter quand même.`,
        requires_confirmation: true,
      });
    }

  // Vérifier les conflits de créneau (même requête que POST /:id/hire/:oeilId)
  const scheduleConflictWindowHoursAdmin = await getSetting(db, 'schedule_conflict_window_hours', 4);
  const { rows: creneauConflicts } = await db.query(`
    SELECT m.id FROM missions m
    WHERE m.oeil_id = $1
      AND m.status IN ('assigned','en_route','active')
      AND m.id != $2
      AND ABS(EXTRACT(EPOCH FROM (m.scheduled_at - $3)) / 3600) < $4::numeric
  `, [oeil_id, mission.id, mission.scheduled_at, scheduleConflictWindowHoursAdmin])

  if (creneauConflicts.length > 0) {
    return res.status(400).json({ error: 'Cet Œil a déjà une mission dans le même créneau.' })
  }

  const { rows: [oeil] } = await db.query('SELECT first_name, last_name FROM users WHERE id=$1', [oeil_id]);

  try {
    await transitionMission(db, mission.id, 'pending', 'assigned', req.user.id, {
      extraFields: {
        oeil_id, assigned_at: 'NOW()', is_priority: false, transfer_deadline: null,
        presence_confirmed_at: null, presence_confirmation_requested_at: null, presence_confirmation_deadline_at: null,
        candidate_window_ends_at: null, pending_candidate_id: null, batch_tiebreak_ends_at: null,
      },
      note: 'Affectation manuelle par admin',
    });
  } catch (e) {
    if (e instanceof MissionTransitionError) return res.status(409).json({ error: e.message });
    throw e;
  }

  // Ardoise vierge sur la cascade par lot (même correctif que POST /:id/accept ci-dessus) —
  // une affectation manuelle admin court-circuite la cascade à tout moment, y compris pendant
  // un lot ou un départage en cours ; sans ce nettoyage, une réouverture future de cette
  // mission hériterait à tort d'un solicited_at/confirmed_at périmé.
  await db.query(`UPDATE mission_interests SET solicited_at=NULL, confirmed_at=NULL WHERE mission_id=$1`, [mission.id]);

  await notify(db, oeil_id,
    '📋 Mission assignée par admin',
    `L'admin vous a assigné la mission "${mission.title}". Vérifiez les détails.`,
    'mission', mission.id, emitToUser, null, 'missionAssignedByAdminTitle', 'missionAssignedByAdminBody', {missionTitle: mission.title}
  );
  await notify(db, mission.client_id,
    '✅ Œil trouvé',
    `Un Œil a été assigné à votre mission "${mission.title}".`,
    'mission', mission.id, emitToUser, null, 'oeilFoundClientTitle', 'oeilFoundClientBody', {missionTitle: mission.title}
  );

  await db.query(
    `INSERT INTO mission_messages (mission_id,sender_id,content,type,content_key,params) VALUES ($1,$2,$3,'system',$4,$5)`,
    [mission.id, req.user.id, `${oeil.first_name} a été assigné par l'admin.`, 'assignedByAdmin', JSON.stringify({ oeilName: oeil.first_name })]
  );

  const cascadeInterruptedMessage = cascadeInterrupted
    ? 'Une cascade de confirmation était en cours pour cette mission — elle a été automatiquement annulée par cette affectation manuelle.'
    : null;

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status: 'assigned' });
  io.to('room:admin').emit('mission_updated', {
    id: mission.id, status: 'assigned',
    ...(cascadeInterrupted ? { cascade_interrupted: true, cascade_interrupted_message: cascadeInterruptedMessage } : {}),
  });

  res.json({
    ok: true,
    cascade_interrupted: cascadeInterrupted,
    ...(cascadeInterrupted ? { cascade_interrupted_message: cascadeInterruptedMessage } : {}),
  });
}));

// ── Cron : vérifier deadlines transfert expirées ──────────
// (appelé depuis index.js via cron)
async function checkTransferDeadlines(db, emitToUser) {
  const { rows: expired } = await db.query(`
    SELECT * FROM missions
    WHERE status='pending' AND is_priority=true
    AND transfer_deadline IS NOT NULL
    AND transfer_deadline < NOW()
  `);

  for (const mission of expired) {
    // Clôturer la mission d'abord, sous garde de statut — si un remplaçant l'a
    // entre-temps acceptée/embauchée (sortie de pending/is_priority) entre le
    // SELECT ci-dessus et cette itération, on ne rejoue pas la pénalité et le
    // remboursement dessus.
    try {
      await transitionMission(db, mission.id, 'pending', 'cancelled', null, {
        extraFields: { cancelled_at: 'NOW()', cancel_reason: 'Aucun remplaçant trouvé avant expiration du délai', is_priority: false, transfer_deadline: null },
        extraGuards: { is_priority: true },
        note: 'Expiration du délai de transfert sans remplaçant',
      });
    } catch (e) {
      if (e instanceof MissionTransitionError) {
        console.log(`ℹ️ checkTransferDeadlines: mission ${mission.id} ignorée, statut déjà changé entre-temps`);
        continue;
      }
      throw e;
    }

    // Pénalité aggravée sur l'Œil 1 si pendant mission
if (mission.transfer_type === 'during' && mission.transferred_from) {
        const { rows: [before] } = await db.query(
          'SELECT balance FROM oeil_profiles WHERE user_id=$1', [mission.transferred_from]
        );
        const deducted = Math.min(100, parseFloat(before?.balance || 0));
        await db.query(
          `UPDATE oeil_profiles SET balance=GREATEST(0, balance-100) WHERE user_id=$1`,
          [mission.transferred_from]
        );
        const abandonCooldownHours = await getSetting(db, 'abandon_during_mission_cooldown_hours', 48);
        await db.query(`
          UPDATE users SET
            transfer_no_replacement_count=transfer_no_replacement_count+1,
            transfer_cooldown_until=NOW() + INTERVAL '1 hour' * $2::numeric
          WHERE id=$1
        `, [mission.transferred_from, abandonCooldownHours]);
        await logReliabilityEvent(db, mission.transferred_from, mission.id, -70, 'Transfert pendant mission sans remplaçant trouvé — abandon en cours de mission', true);
        await db.query(
          `INSERT INTO wallet_transactions (user_id,type,amount,reason,mission_id) VALUES ($1,'debit',$2,'Pénalité — aucun remplaçant trouvé',$3)`,
          [mission.transferred_from, deducted, mission.id]
        );

      await emitToUser?.(mission.transferred_from, 'notification', {
        title: '⚠️ Pénalité appliquée',
        body: `Aucun remplaçant n'a été trouvé pour "${mission.title}". -100 MAD déduits.`,
        type: 'warning'
      });
      
       } else if (mission.transfer_type === 'before' && mission.transferred_from) {
      await logReliabilityEvent(db, mission.transferred_from, mission.id, -10, 'Transfert avant démarrage sans remplaçant trouvé', true);
   
    }

// Remboursement client — annulation par le système (aucun remplaçant trouvé), non imputable au client : intégral
      await refundOnCancellation(db, mission, false, 'Remboursement — aucun Œil disponible');

    await emitToUser?.(mission.client_id, 'notification', {
      title: '❌ Mission annulée',
      body: `Aucun Œil disponible pour "${mission.title}". Remboursement intégral effectué.`,
      type: 'error'
    });

    await db.query(
      `INSERT INTO notifications (user_id,title,body,type,mission_id,action_type,title_key,body_key,params) VALUES ($1,'❌ Mission annulée','Aucun Œil disponible. Remboursement intégral effectué.','error',$2,'mission_view',$3,$4,$5)`,
      [mission.client_id, mission.id, 'missionCancelledNoReplacementTitle', 'missionCancelledNoReplacementBody', null]
    );
  }
}

// ── Cron : confirmations de présence expirées sans réponse ──────────────
// (appelé depuis index.js via cron) — déclenche le mécanisme universel de remplacement
// (advanceCandidateCascade) exactement comme PUT /users/admin/:id/toggle-active
// (désactivation admin, voir routes/users.js) : aucune pénalité, aucun mouvement financier,
// aucun cooldown ni transfer_count — une absence de réponse au délai de confirmation n'est
// pas une faute avérée (voir rapport de session, règle e). transfer_type est toujours
// 'before' : cette vérification ne porte que sur des missions encore 'assigned' (jamais
// en_route/active — la confirmation de présence se joue entièrement avant le début).
// La suite (recherche séquentielle de remplaçant, passage en urgent si liste épuisée,
// annulation + remboursement si aucun remplaçant avant transfer_deadline) est entièrement
// gérée par l'infrastructure existante (advanceCandidateCascade, checkTransferDeadlines
// ci-dessus) — rien de nouveau n'est construit ici pour ces étapes.
async function checkPresenceConfirmationDeadlines(db, io, emitToUser) {
  const { rows: expired } = await db.query(`
    SELECT m.*, u.first_name, u.last_name
    FROM missions m
    JOIN users u ON u.id = m.oeil_id
    WHERE m.status='assigned'
      AND m.oeil_id IS NOT NULL
      AND m.presence_confirmation_deadline_at IS NOT NULL
      AND m.presence_confirmation_deadline_at <= NOW()
      AND m.presence_confirmed_at IS NULL
  `);

  for (const mission of expired) {
    const oeilId = mission.oeil_id;

    const graceMinutesQueue = await getSetting(db, 'transfer_grace_minutes_queue', 45);
    const graceMinutesOther = await getSetting(db, 'transfer_grace_minutes_other', 60);
    const graceMinutes = mission.type === 'file_attente' ? graceMinutesQueue : graceMinutesOther;
    const deadline = new Date(Date.now() + graceMinutes * 60 * 1000);

    let updated;
    try {
      updated = await transitionMission(db, mission.id, 'assigned', 'pending', null, {
        extraFields: {
          is_priority: true,
          transfer_type: 'before',
          transferred_from: oeilId,
          transfer_reason: 'Confirmation de présence non reçue avant expiration du délai',
          transfer_deadline: deadline,
          oeil_id: null,
          presence_confirmed_at: null,
          presence_confirmation_requested_at: null,
          presence_confirmation_deadline_at: null,
        },
        extraGuards: { oeil_id: oeilId },
        note: 'Réattribution automatique — confirmation de présence non reçue à temps',
      });
    } catch (e) {
      if (e instanceof MissionTransitionError) {
        console.log(`ℹ️ checkPresenceConfirmationDeadlines: mission ${mission.id} ignorée, statut déjà changé entre-temps`);
        continue;
      }
      throw e;
    }

    // Retire la propre candidature de l'Œil sur sa propre mission (même correctif que
    // POST /:id/transfer et la désactivation admin, voir bug fantôme audit 2.9) avant de
    // lancer la cascade.
    await db.query(`DELETE FROM mission_interests WHERE mission_id=$1 AND oeil_id=$2`, [updated.id, oeilId]);

    await advanceCandidateCascade(db, io, emitToUser, updated, {});

    await notify(db, oeilId,
      '⏰ Présence non confirmée',
      `Vous n'avez pas confirmé votre présence à temps pour "${mission.title}". La mission a été réattribuée. Aucune pénalité ni retenue financière ne vous est appliquée.`,
      'warning', mission.id, emitToUser, null, 'presenceNotConfirmedReassignedTitle', 'presenceNotConfirmedReassignedBody',
      { missionTitle: mission.title }
    );

    const { rows: [oeilContact] } = await db.query('SELECT phone FROM users WHERE id=$1', [oeilId]);
    if (oeilContact?.phone) {
      await sendWhatsAppTemplate(waselTemplates.presence_not_confirmed_no_penalty.template_name, oeilContact.phone, [mission.title, 'Aucune pénalité']);
    }

    const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
    for (const admin of admins) {
      await notify(db, admin.id,
        '🔄 Réattribution automatique — présence non confirmée',
        `L'Œil ${mission.first_name} ${mission.last_name} n'a pas confirmé sa présence à temps pour "${mission.title}". Réattribution automatique lancée, aucune pénalité appliquée.`,
        'warning', mission.id, emitToUser, 'admin_missions', 'presenceNotConfirmedAdminTitle', 'presenceNotConfirmedAdminBody',
        { missionTitle: mission.title, oeilName: `${mission.first_name} ${mission.last_name}` }
      );
    }

    if (io) io.to('room:admin').emit('mission_updated', { id: mission.id, status: 'pending', is_priority: true });
    console.log(`⏰ Confirmation de présence non reçue à temps — mission ${mission.id}, Œil ${oeilId} retiré sans pénalité`);
  }
}


// ── Cœur de la logique d'embauche d'un Œil parmi les intéressés — réutilisé
// par POST /:id/hire/:oeilId (choix initial du client), par POST /:id/candidate-confirm
// (confirmation d'un candidat sollicité par advanceCandidateCascade, ci-dessous), et
// historiquement par le cron de sélection automatique fast/choose (remplacé). Retourne
// { ok:false, status, error } si une vérification échoue, ou { ok:true, mission } en cas
// de succès.
async function hireOeilCore(db, io, emitToUser, mission, oeilId, opts) {
  const {
    changedById = null,
    historyNote = 'Œil choisi parmi les intéressés',
    oeilNotifTitle = '🎉 Vous avez été sélectionné !',
    oeilNotifBody = `Vous avez été retenu pour : ${mission.title}`,
    oeilNotifTitleKey = null,
    oeilNotifBodyKey = null,
    oeilNotifParams = null,
  } = opts || {};

  // Vérifier suspension et cooldown de transfert — sur l'Œil qu'on embauche, pas sur le client
  const { rows: [oeilUser] } = await db.query(
    'SELECT is_suspended, transfer_cooldown_until FROM users WHERE id=$1', [oeilId]
  );
  if (oeilUser?.is_suspended || (oeilUser?.transfer_cooldown_until && new Date(oeilUser.transfer_cooldown_until) > new Date())) {
    // Message volontairement générique côté client — la raison précise (suspension, cooldown)
    // est une information interne de fiabilité, non communicable au client.
    return { ok: false, status: 403, error: 'Cet Œil n\'est plus disponible pour cette mission.' };
  }

  const { rows: [interest] } = await db.query(
    'SELECT * FROM mission_interests WHERE mission_id=$1 AND oeil_id=$2',
    [mission.id, oeilId]
  );
  if (!interest) return { ok: false, status: 400, error: "Cet Œil n'a pas exprimé son intérêt" };

  // Vérifier le créneau avant assignation (doit précéder toute mutation de la mission)
  const scheduleConflictWindowHours = await getSetting(db, 'schedule_conflict_window_hours', 4);
  const { rows: creneauConflicts } = await db.query(`
    SELECT m.id FROM missions m
    WHERE m.oeil_id = $1
      AND m.status IN ('assigned','en_route','active')
      AND m.id != $2
      AND ABS(EXTRACT(EPOCH FROM (m.scheduled_at - $3)) / 3600) < $4::numeric
  `, [oeilId, mission.id, mission.scheduled_at, scheduleConflictWindowHours])

  if (creneauConflicts.length > 0) {
    return { ok: false, status: 400, error: 'Cet Œil a déjà une mission dans le même créneau.' };
  }

  // candidate_window_ends_at, pending_candidate_id et batch_tiebreak_ends_at remis à NULL ici
  // (même en dehors du cron/de la cascade) pour qu'une sélection manuelle par le client
  // n'importe quand empêche définitivement toute reprise ultérieure de la cascade de
  // confirmation sur cette mission (voir advanceCandidateCascade).
  let updated;
  try {
    updated = await transitionMission(db, mission.id, 'pending', 'assigned', changedById, {
      extraFields: {
        oeil_id: oeilId, assigned_at: 'NOW()', is_priority: false, transfer_deadline: null, candidate_window_ends_at: null, pending_candidate_id: null, batch_tiebreak_ends_at: null,
        presence_confirmed_at: null, presence_confirmation_requested_at: null, presence_confirmation_deadline_at: null,
      },
      note: historyNote,
    });
  } catch (e) {
    if (e instanceof MissionTransitionError) return { ok: false, status: 409, error: e.message };
    throw e;
  }

  // Ardoise vierge sur la cascade par lot (même correctif que POST /:id/accept et
  // /:id/assign-admin) — voir garde-fous de la spec réattribution par lot.
  await db.query(`UPDATE mission_interests SET solicited_at=NULL, confirmed_at=NULL WHERE mission_id=$1`, [mission.id]);

    // Mission issue d'un transfert en cours de route : on ouvre une nouvelle ligne dans la chaîne
    // pour ce nouvel Œil (elle sera fermée à son tour s'il retransfère, ou au moment de la validation finale).
    if (mission.transfer_type === 'during') {
      const { rows: [{ n: nextOrder }] } = await db.query(
        `SELECT COALESCE(MAX(sequence_order), 0) + 1 AS n FROM mission_transfer_chain WHERE mission_id=$1`,
        [updated.id]
      );
      await db.query(
        `INSERT INTO mission_transfer_chain (mission_id, oeil_id, started_at, sequence_order)
         VALUES ($1, $2, NOW(), $3)`,
        [updated.id, updated.oeil_id, nextOrder]
      );
    }

  // Supprimer les intérêts en conflit de créneau
  const { rows: conflictInterests } = await db.query(`
    SELECT mi.mission_id FROM mission_interests mi
    JOIN missions m ON m.id = mi.mission_id
    WHERE mi.oeil_id = $1
      AND mi.mission_id != $2
      AND m.status = 'pending'
      AND ABS(EXTRACT(EPOCH FROM (m.scheduled_at - $3)) / 3600) < $4::numeric
  `, [oeilId, mission.id, mission.scheduled_at, scheduleConflictWindowHours])

  for (const ci of conflictInterests) {
    await db.query(
      `DELETE FROM mission_interests WHERE oeil_id=$1 AND mission_id=$2`,
      [oeilId, ci.mission_id]
    )
  }

  // Notifier l'Œil embauché
  await notify(db, oeilId, oeilNotifTitle, oeilNotifBody, 'hired', mission.id, emitToUser, null, oeilNotifTitleKey, oeilNotifBodyKey, oeilNotifParams);

  // Test technique API Wasel (WhatsApp) — envoie sur le numéro personnel de l'Œil embauché.
  // Variable {{1}} : nom du client qui l'a choisi (info la plus pertinente pour l'Œil à ce stade).
  const { rows: [oeilContact] } = await db.query('SELECT phone FROM users WHERE id=$1', [oeilId]);
  if (oeilContact?.phone) {
    const { rows: [clientContact] } = await db.query('SELECT first_name, last_name FROM users WHERE id=$1', [mission.client_id]);
    const clientName = clientContact ? `${clientContact.first_name} ${clientContact.last_name}`.trim() : 'Client';
    await sendWhatsAppTemplate(waselTemplates.oeil_hired.template_name, oeilContact.phone, [clientName]);
  } else {
    console.warn(`[wasel] Œil ${oeilId} sans téléphone renseigné — envoi ignoré (hire)`);
  }

  // Notifier les Œils non retenus
  const { rows: others } = await db.query(
    'SELECT oeil_id FROM mission_interests WHERE mission_id=$1 AND oeil_id!=$2',
    [mission.id, oeilId]
  );
  for (const o of others) {
    await notify(db, o.oeil_id, 'Mission pourvue',
      `"${mission.title}" a été attribuée à un autre Œil.`, 'info', mission.id, emitToUser, null, 'missionFilledTitle', 'missionFilledBody', {missionTitle: mission.title});
  }

  if (io) io.to('room:admin').emit('mission_assigned', updated);

  return { ok: true, mission: updated };
}

// Un lot est-il actuellement en cours de sollicitation pour cette mission — fenêtre de lot
// partagée (candidate_window_ends_at) encore ouverte, OU fenêtre de départage ouverte par une
// première confirmation (batch_tiebreak_ends_at) ? N'importe où dans le fichier : les deux
// champs sont toujours présents sur un objet mission chargé via SELECT * / RETURNING *.
function isBatchLive(mission) {
  const now = Date.now();
  if (mission.batch_tiebreak_ends_at && new Date(mission.batch_tiebreak_ends_at).getTime() > now) return true;
  if (mission.candidate_window_ends_at && new Date(mission.candidate_window_ends_at).getTime() > now) return true;
  return false;
}

// ── Cascade de confirmation PAR LOT — remplace l'ancienne cascade séquentielle un-par-un ──
// Un seul mécanisme, quelle que soit la cause : sollicite SIMULTANÉMENT jusqu'à
// `candidate_batch_size` candidats de mission_interests (reliability_score DESC, rating_avg
// DESC — même classement que l'ancien cron/l'ancienne cascade), attend une confirmation
// ACTIVE de chacun (jamais d'auto-assignation directe). Dès la première confirmation reçue
// (voir POST /:id/candidate-confirm), une fenêtre de départage (candidate_tiebreak_window_
// minutes) s'ouvre pour laisser une chance aux autres confirmations du lot ; à son expiration,
// le mieux classé parmi les confirmés est assigné (voir cron dédié, index.js). Si le lot entier
// expire (candidate_confirmation_minutes) sans AUCUNE confirmation, passage au lot suivant.
// Liste épuisée → is_urgent=true, visible publiquement (voir GET / mode=available), sans
// jamais resolliciter le client pour un choix — il est seulement informé.
// Réutilisée par : POST /:id/refuse, POST /:id/transfer, PUT /users/admin/:id/toggle-active
// (désactivation), checkPresenceConfirmationDeadlines, POST /:id/interest (relance post-
// urgent), et le cron de lot expiré (index.js). Idempotente/sûre à tout instant : si un lot
// est déjà en cours (isBatchLive), ne fait rien de plus que les opts ci-dessous — ne perturbe
// jamais un cycle en cours.
//
// opts.excludeOeilId  : Œil qui vient de devenir indisponible (déclencheur initial) — sa
//   propre candidature sur cette mission est retirée avant de tirer le lot.
// opts.declinedOeilId : candidat qui vient de refuser explicitement — mission_interests.
//   declined=true, exclusion DÉFINITIVE de cette mission. (Non utilisé par POST /:id/candidate-
//   decline depuis le passage par lot — un refus individuel ne doit pas perturber le reste du
//   lot en cours ; conservé pour compatibilité d'appel.)
// opts.timedOutOeilId : conservé pour compatibilité d'appel (l'ancien timeout individuel est
//   remplacé par le timeout de LOT entier, géré directement par le cron via un tirage frais,
//   sans passer par cet opt) — ligne mission_interests supprimée si jamais fourni.
async function advanceCandidateCascade(db, io, emitToUser, mission, opts = {}) {
  const { excludeOeilId = null, declinedOeilId = null, timedOutOeilId = null } = opts;

  if (excludeOeilId) {
    await db.query(`DELETE FROM mission_interests WHERE mission_id=$1 AND oeil_id=$2`, [mission.id, excludeOeilId]);
  }
  if (declinedOeilId) {
    await db.query(`UPDATE mission_interests SET declined=true WHERE mission_id=$1 AND oeil_id=$2`, [mission.id, declinedOeilId]);
  }
  if (timedOutOeilId) {
    await db.query(`DELETE FROM mission_interests WHERE mission_id=$1 AND oeil_id=$2`, [mission.id, timedOutOeilId]);
  }

  // Un lot (ou une fenêtre de départage) est déjà en cours : les opts ci-dessus ont déjà été
  // appliqués si besoin, mais on ne redessine jamais un nouveau lot par-dessus un cycle en
  // cours — la priorité départage/lot-complet est gérée par les crons appelants (index.js).
  if (isBatchLive(mission)) return;

  // Nouveau tirage de lot : ardoise vierge sur mission_interests pour cette mission — un cycle
  // précédent résolu puis rouvert (refus, transfert, désactivation admin...) ne doit jamais
  // laisser fuiter un solicited_at/confirmed_at périmé sur le cycle suivant.
  await db.query(`UPDATE mission_interests SET solicited_at=NULL, confirmed_at=NULL WHERE mission_id=$1`, [mission.id]);

  const batchSize = await getSetting(db, 'candidate_batch_size', 10);
  const { rows: candidates } = await db.query(`
    SELECT u.id
    FROM mission_interests mi
    JOIN users u ON u.id = mi.oeil_id
    LEFT JOIN oeil_profiles p ON p.user_id = u.id
    WHERE mi.mission_id = $1 AND mi.declined = false
    ORDER BY u.reliability_score DESC, p.rating_avg DESC
    LIMIT $2
  `, [mission.id, batchSize]);

  if (candidates.length > 0) {
    const candidateIds = candidates.map(c => c.id);
    const confirmationMinutes = await getSetting(db, 'candidate_confirmation_minutes', 10);
    const windowEndsAt = new Date(Date.now() + confirmationMinutes * 60 * 1000);

    // Garde optimiste : si la mission a changé de statut entre-temps (déjà assignée par un
    // autre chemin, annulée...), on n'écrase rien. pending_candidate_id garde le mieux classé
    // du lot à titre indicatif (affichage admin) uniquement — voir commentaire sur la colonne.
    const { rowCount } = await db.query(
      `UPDATE missions SET pending_candidate_id=$1, candidate_window_ends_at=$2, batch_tiebreak_ends_at=NULL, updated_at=NOW()
       WHERE id=$3 AND status='pending' AND oeil_id IS NULL`,
      [candidateIds[0], windowEndsAt, mission.id]
    );
    if (rowCount === 0) return;

    await db.query(
      `UPDATE mission_interests SET solicited_at=NOW() WHERE mission_id=$1 AND oeil_id = ANY($2::text[])`,
      [mission.id, candidateIds]
    );

    // Sollicitation SIMULTANÉE de tout le lot (notification in-app + WhatsApp à chacun).
    for (const nextOeilId of candidateIds) {
      await notify(db, nextOeilId,
        '🎯 Confirmez votre disponibilité',
        `Vous êtes parmi les candidats les mieux classés pour "${mission.title}". Confirmez votre disponibilité sous ${confirmationMinutes} min pour être considéré.`,
        'mission', mission.id, emitToUser, 'mission_view', 'candidateConfirmRequestTitle', 'candidateConfirmRequestBody',
        { missionTitle: mission.title, minutes: confirmationMinutes }
      );

      const { rows: [candidateContact] } = await db.query('SELECT phone FROM users WHERE id=$1', [nextOeilId]);
      if (candidateContact?.phone) {
        await sendWhatsAppTemplate(waselTemplates.candidate_confirmation_request.template_name, candidateContact.phone, [mission.title, String(confirmationMinutes)]);
      }
    }

    if (io) io.to('room:admin').emit('mission_updated', { id: mission.id, pending_candidate_id: candidateIds[0], batch_candidate_count: candidateIds.length });
  } else {
    const { rowCount } = await db.query(
      `UPDATE missions SET is_urgent=true, pending_candidate_id=NULL, candidate_window_ends_at=NULL, batch_tiebreak_ends_at=NULL, updated_at=NOW()
       WHERE id=$1 AND status='pending' AND oeil_id IS NULL`,
      [mission.id]
    );
    if (rowCount === 0) return;

    await notify(db, mission.client_id,
      '🔎 Recherche élargie',
      `Nous élargissons la recherche d'un remplaçant pour "${mission.title}" à tous les Œils disponibles.`,
      'mission', mission.id, emitToUser, null, 'missionUrgentBroadenedTitle', 'missionUrgentBroadenedBody',
      { missionTitle: mission.title }
    );

    const { rows: [clientContact] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.client_id]);
    if (clientContact?.phone) {
      await sendWhatsAppTemplate(waselTemplates.mission_urgent_broadened.template_name, clientContact.phone, [mission.title]);
    }

    if (io) io.to('room:admin').emit('mission_updated', { id: mission.id, is_urgent: true });
  }
}

// ── POST /:id/hire/:oeilId ── Client choisit un Œil ───────
router.post('/:id/hire/:oeilId', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1 AND client_id=$2',
    [req.params.id, req.user.id]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.status !== 'pending') return res.status(400).json({ error: 'Mission non disponible' });

  const result = await hireOeilCore(db, io, emitToUser, mission, req.params.oeilId, {
    changedById: req.user.id,
    historyNote: 'Œil choisi par le client parmi les intéressés',
    oeilNotifTitle: '🎉 Vous avez été sélectionné !',
    oeilNotifBody: `Le client vous a choisi pour : ${mission.title}`,
    oeilNotifTitleKey: 'oeilSelectedTitle',
    oeilNotifBodyKey: 'oeilSelectedBody',
    oeilNotifParams: {missionTitle: mission.title},
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  res.json({ mission: result.mission });
}));

// ── POST /:id/candidate-confirm ── Le candidat sollicité confirme sa disponibilité ──
// (voir advanceCandidateCascade) — seul un membre du lot actuellement sollicité (mission_
// interests.solicited_at IS NOT NULL, non refusé) peut confirmer. N'assigne JAMAIS
// immédiatement : enregistre seulement confirmed_at sur sa ligne. Dès la première
// confirmation du lot, ouvre la fenêtre de départage (candidate_tiebreak_window_minutes,
// SOUS GARDE IS NULL — fenêtre fixe depuis la 1ère confirmation, jamais repoussée par les
// confirmations suivantes). La résolution (mieux classé parmi les confirmés → hireOeilCore)
// est tranchée par le cron dédié (index.js), pas ici — voir spec réattribution par lot,
// points 3/4/5.
router.post('/:id/candidate-confirm', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const io = req.app.get('io');

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.status !== 'pending' || mission.oeil_id) {
    return res.status(409).json({ error: 'Cette mission a déjà été attribuée à un autre Œil.' });
  }

  const { rows: [interestRow] } = await db.query(
    `SELECT confirmed_at FROM mission_interests
     WHERE mission_id=$1 AND oeil_id=$2 AND solicited_at IS NOT NULL AND declined=false`,
    [mission.id, req.user.id]
  );
  if (!interestRow) {
    return res.status(403).json({ error: "Vous n'êtes pas (ou plus) sollicité pour cette mission." });
  }
  if (interestRow.confirmed_at) {
    return res.json({ ok: true, already_confirmed: true, confirmed_at: interestRow.confirmed_at, batch_tiebreak_ends_at: mission.batch_tiebreak_ends_at });
  }

  const tiebreakMinutes = await getSetting(db, 'candidate_tiebreak_window_minutes', 5);

  // Les deux écritures (confirmation + éventuelle ouverture de la fenêtre de départage)
  // forment un seul événement logique — transaction pour éviter qu'un crash entre les deux
  // laisse une confirmation enregistrée sans jamais ouvrir la fenêtre qui la traite.
  const { confirmedAt, batchTiebreakEndsAt } = await walletService.withTransaction(db, async (client) => {
    const { rows: [ci] } = await client.query(
      `UPDATE mission_interests SET confirmed_at=NOW() WHERE mission_id=$1 AND oeil_id=$2 RETURNING confirmed_at`,
      [mission.id, req.user.id]
    );
    const { rows: [tb] } = await client.query(
      `UPDATE missions SET batch_tiebreak_ends_at = NOW() + INTERVAL '1 minute' * $2::numeric
       WHERE id=$1 AND batch_tiebreak_ends_at IS NULL
       RETURNING batch_tiebreak_ends_at`,
      [mission.id, tiebreakMinutes]
    );
    let batchTiebreakEndsAt = tb?.batch_tiebreak_ends_at;
    if (!batchTiebreakEndsAt) {
      const { rows: [m2] } = await client.query('SELECT batch_tiebreak_ends_at FROM missions WHERE id=$1', [mission.id]);
      batchTiebreakEndsAt = m2.batch_tiebreak_ends_at;
    }
    return { confirmedAt: ci.confirmed_at, batchTiebreakEndsAt };
  });

  if (io) io.to('room:admin').emit('mission_updated', { id: mission.id, batch_tiebreak_ends_at: batchTiebreakEndsAt });

  res.json({ ok: true, confirmed_at: confirmedAt, batch_tiebreak_ends_at: batchTiebreakEndsAt });
}));

// ── POST /:id/candidate-decline ── Le candidat sollicité refuse explicitement ──
// Exclusion définitive de cette mission (mission_interests.declined=true). Ne perturbe pas
// le reste du lot en cours (pas de tirage d'un lot de remplacement immédiat) — les autres
// membres du lot continuent d'être sollicités normalement jusqu'à résolution/expiration.
router.post('/:id/candidate-decline', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const io = req.app.get('io');

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  const { rows: [updated] } = await db.query(
    `UPDATE mission_interests SET declined=true, confirmed_at=NULL
     WHERE mission_id=$1 AND oeil_id=$2 AND solicited_at IS NOT NULL AND declined=false
     RETURNING oeil_id`,
    [mission.id, req.user.id]
  );
  if (!updated) {
    return res.status(403).json({ error: "Vous n'êtes pas (ou plus) sollicité pour cette mission." });
  }

  if (io) io.to('room:admin').emit('mission_updated', { id: mission.id });
  res.json({ ok: true });
}));


// ── DÉPRÉCIATION CANDIDATE ──────────────────────────────────
// Ce système de signalement à sens unique (mission_problem_reports) est remplacé
// par le système de tickets bidirectionnel (voir routes/tickets.js, POST /api/tickets).
// Le frontend n'appelle plus report-problem (bouton "Signaler un problème" migré vers
// NewTicketModal). Conservé tel quel pour l'historique et le temps de confirmer que le
// nouveau système tient la route en production — à supprimer dans un futur nettoyage
// (table, ces 3 routes, et la page frontend MesSignalements/AdminProblemes).
// ── POST /missions/:id/report-problem ── Signaler un problème ──
router.post('/:id/report-problem', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');
  const { type, description } = req.body;

  if (!type) return res.status(400).json({ error: 'Type de problème requis' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  const canReport = mission.client_id === req.user.id || mission.oeil_id === req.user.id;
  if (!canReport) return res.status(403).json({ error: 'Accès refusé' });

  if (!['assigned','en_route','active'].includes(mission.status)) {
    return res.status(400).json({ error: 'Mission non active' });
  }

  // Vérifier qu'un signalement n'existe pas déjà pour cette mission (contrainte UNIQUE en base)
    const { rows: [existingReport] } = await db.query(
      `SELECT id FROM mission_problem_reports WHERE mission_id=$1`, [mission.id]
    );
    if (existingReport) {
      return res.status(409).json({ error: 'Un problème a déjà été signalé pour cette mission' });
    }
    // Créer le ticket
    const reporterRole = req.user.id === mission.client_id ? 'client' : 'oeil';
    const { rows: [report] } = await db.query(
      `INSERT INTO mission_problem_reports (mission_id, reporter_id, reporter_role, type, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [mission.id, req.user.id, reporterRole, type, description || null]
  );

  // Passer la mission en sous_surveillance
  await db.query(
    `UPDATE missions SET under_surveillance=true, updated_at=NOW() WHERE id=$1`,
    [mission.id]
  );

  // Notifier l'admin
  const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
  for (const admin of admins) {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
       VALUES ($1, '🚨 Problème signalé en cours de mission', $2, 'error', $3, 'admin_problems', $4, $5, $6)`,
      [admin.id, `${reporterRole === 'client' ? 'Client' : 'Œil'} a signalé : "${type}" sur "${mission.title}"`, mission.id,
       'problemReportedAdminTitle', 'problemReportedAdminBody', JSON.stringify({reporterRole: reporterRole === 'client' ? 'Client' : 'Œil', problemType: type, missionTitle: mission.title})]
    );
    if (emitToUser) emitToUser(admin.id, 'notification', {
      title: '🚨 Problème signalé en cours de mission',
      body: `"${type}" sur "${mission.title}"`,
      missionId: mission.id,
      type: 'error'
    });
  }

  // Notifier l'autre partie
  const otherId = req.user.id === mission.client_id ? mission.oeil_id : mission.client_id;
  if (otherId) {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
       VALUES ($1, '⚠️ Problème signalé sur votre mission', $2, 'warning', $3, 'mission_view', $4, $5, $6)`,
      [otherId, `Un problème a été signalé : "${type}". L'équipe Shoofly a été alertée.`, mission.id,
       'problemReportedPartyTitle', 'problemReportedPartyBody', JSON.stringify({problemType: type})]
    );
    if (emitToUser) emitToUser(otherId, 'notification', {
      title: '⚠️ Problème signalé',
      body: `"${type}" — Shoofly a été alerté`,
      missionId: mission.id,
      type: 'warning'
    });
  }

  // Émettre aux deux parties connectées
  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, under_surveillance: true });
  io.to('room:admin').emit('mission_problem_reported', { missionId: mission.id, type, reporterRole });

  res.status(201).json({ report });
}));

// ── GET /missions/admin/problems — admin liste les tickets ──
router.get('/admin/problems', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
      const db = getDb();
      const { status = 'open', page = 1, limit = 20, type, city, reporter_role, sort } = req.query;
      const offset = (page - 1) * limit;

      let where = ['r.status=$1'], params = [status];
      let p = 2;
      if (type) { where.push(`r.type=$${p++}`); params.push(type); }
      if (city) { where.push(`m.city=$${p++}`); params.push(city); }
      if (reporter_role) { where.push(`r.reporter_role=$${p++}`); params.push(reporter_role); }
      const wc = 'WHERE ' + where.join(' AND ');

      const orderBy = sort === 'execution_asc' ? 'm.scheduled_at ASC NULLS LAST'
        : sort === 'execution_desc' ? 'm.scheduled_at DESC NULLS LAST'
        : 'r.created_at ASC'; // Signalement le plus ancien en premier, par défaut

      const { rows } = await db.query(`
          SELECT r.*,
          m.title AS mission_title, m.city, m.scheduled_at, m.id AS mission_ref_id,
          u.first_name AS reporter_first, u.last_name AS reporter_last,
          c.id AS client_id, c.first_name AS client_first, c.last_name AS client_last,
          o.id AS oeil_id, o.first_name AS oeil_first, o.last_name AS oeil_last
          FROM mission_problem_reports r
          JOIN missions m ON m.id = r.mission_id
          JOIN users u ON u.id = r.reporter_id
          LEFT JOIN users c ON c.id = m.client_id
        LEFT JOIN users o ON o.id = m.oeil_id
        ${wc}
        ORDER BY ${orderBy}
        LIMIT $${p++} OFFSET $${p++}
      `, [...params, limit, offset]);

      const { rows: [{ n: total }] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM mission_problem_reports r JOIN missions m ON m.id = r.mission_id ${wc}`, params
      );

      // Villes distinctes disponibles pour peupler le filtre (sur le statut actif, indépendamment des autres filtres)
      const { rows: cities } = await db.query(`
        SELECT DISTINCT m.city FROM mission_problem_reports r JOIN missions m ON m.id = r.mission_id
          WHERE r.status=$1 ORDER BY m.city ASC
      `, [status]);

      res.json({ reports: rows, total, page: +page, pages: Math.ceil(total / limit), availableCities: cities.map(c => c.city) });
  }));

// ── PUT /missions/admin/problems/:id — admin traite un ticket ──
router.put('/admin/problems/:id', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
    const db = getDb();
    const { status, admin_note } = req.body;
    const { rows: [report] } = await db.query(
        `UPDATE mission_problem_reports SET status=$1, admin_note=$2, resolved_by=$3, resolved_at=NOW()
         WHERE id=$4 RETURNING *`,
      [status, admin_note || null, req.user.id, req.params.id]
    );
    if (!report) return res.status(404).json({ error: 'Ticket introuvable' });

    // Notifier le rapporteur (client ou Œil) de la décision admin — persistant, consultable même si la notif est ratée
    const emitToUser = req.app.get('emitToUser');
    const statusLabel = { in_progress: 'pris en charge', resolved: 'résolu', dismissed: 'classé sans suite' }[status] || status;
    const reportStatusTitleKey = { in_progress: 'reportStatusInProgressTitle', resolved: 'reportStatusResolvedTitle', dismissed: 'reportStatusDismissedTitle' }[status] || null;
    const reportBodyKey = admin_note ? null : 'reportStatusDefaultBody';
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, mission_id, action_type, title_key, body_key, params)
       VALUES ($1, $2, $3, 'info', $4, 'mes_signalements', $5, $6, $7)`,
      [report.reporter_id, `📋 Votre signalement a été ${statusLabel}`, admin_note || 'Votre signalement a été traité par notre équipe.', report.mission_id,
       reportStatusTitleKey, reportBodyKey, null]
    );
    if (emitToUser) emitToUser(report.reporter_id, 'notification', {
      title: `📋 Votre signalement a été ${statusLabel}`,
      body: admin_note || 'Votre signalement a été traité par notre équipe.',
      missionId: report.mission_id
    });

    // Si résolu → retirer sous_surveillance si plus aucun ticket ouvert
    if (['resolved','dismissed'].includes(status)) {
      const { rows: [{ n }] } = await db.query(
          `SELECT COUNT(*)::int AS n FROM mission_problem_reports WHERE mission_id=$1 AND status='open'`,
        [report.mission_id]
      );
      if (n === 0) {
        await db.query(`UPDATE missions SET under_surveillance=false WHERE id=$1`, [report.mission_id]);
      }
    }

  res.json({ report });
}));


// ── Cron : expirer les demandes de modification sans réponse de l'Œil ─────
// (appelé depuis index.js via cron) — même logique que POST /edit-requests/:id/reject,
// SANS pénalité, juste avec status='expired' plutôt que 'rejected' et un message
// client différent ("l'Œil n'a pas répondu à temps" plutôt que "a refusé").
async function checkMissionEditRequestExpiry(db, emitToUser) {
  const { rows: expired } = await db.query(`
    SELECT * FROM mission_edit_requests WHERE status='pending' AND expires_at <= NOW()
  `);

  for (const editRequest of expired) {
    const { rowCount } = await db.query(
      `UPDATE mission_edit_requests SET status='expired', resolved_at=NOW() WHERE id=$1 AND status='pending'`,
      [editRequest.id]
    );
    if (rowCount === 0) continue; // déjà traitée entre-temps (approve/reject manuel)

    const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [editRequest.mission_id]);
    if (!mission) continue;

    let updatedMission;
    try {
      updatedMission = await transitionMission(db, mission.id, 'assigned', 'pending', null, {
        extraFields: { oeil_id: null, is_priority: true, transfer_deadline: null },
        note: 'Demande de modification expirée (délai dépassé sans réponse de l\'Œil)',
      });
    } catch (e) {
      if (e instanceof MissionTransitionError) {
        console.log(`ℹ️ checkMissionEditRequestExpiry: mission ${mission.id} ignorée, statut déjà changé entre-temps`);
        continue;
      }
      throw e;
    }

    await notify(db, mission.client_id,
      'Mission remise en recherche',
      `L'Œil n'a pas répondu à temps à votre demande de modification sur "${mission.title}". Nous recherchons un nouvel Œil, sans frais ni pénalité pour vous.`,
      'mission', mission.id, emitToUser, 'mission_view', 'editRequestExpiredClientTitle', 'editRequestExpiredClientBody',
      { missionTitle: mission.title }
    );

    const { rows: [clientContact] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.client_id]);
    if (clientContact?.phone) {
      await sendWhatsAppTemplate(waselTemplates.edit_request_expired.template_name, clientContact.phone, [mission.title, 'Mission remise en recherche']);
    }
  }
}

router.checkTransferDeadlines = checkTransferDeadlines;
router.checkMissionEditRequestExpiry = checkMissionEditRequestExpiry;
router.checkPresenceConfirmationDeadlines = checkPresenceConfirmationDeadlines;
router.hireOeilCore = hireOeilCore;
router.advanceCandidateCascade = advanceCandidateCascade;
router.notify = notify;
module.exports = router;
