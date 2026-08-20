const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/permissions');
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
const { resolveQuartier, validateCityInput } = require('../constants/villes');
const { isValidSubcategory } = require('../constants/missionCategories');
const { checkOeilAssignable, checkOeilsAssignableBulk, getScheduleConflictSetBulk } = require('../utils/oeilAssignment');
const { checkCashCommissionBalance, settleCashCommission } = require('../utils/cashCommission');
const { generateUniqueReference } = require('../utils/ticketReference');


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

// Évince tous les sockets actuellement dans la room mission:<id> — appelé à chaque transition
// vers 'completed'/'cancelled', quel que soit le chemin emprunté (POST /:id/status,
// /:id/assistance/respond, PUT /admin/claims/:missionId/resolve, checkTransferDeadlines,
// checkAssistanceRequestExpiry — voir RAPPORT_DIAGNOSTIC_RAPPEL_CLIENT_ET_CHAT_MISSION.md §2.3).
// N'affecte ni mission_messages (historique jamais purgé) ni un futur re-join : join_mission
// (index.js) ne vérifie aucun statut, donc une mission qui repasse par sous_reclamation
// redevient normalement joignable sans rien de plus ici. Appeler APRÈS tout db.query/emit qui
// doit encore atteindre les participants actuellement dans la room (ex: le message système de
// clôture) — l'ordre d'appel fait foi, socketsLeave() est synchrone. Double optional chaining
// délibéré (pas juste io?.) : un stub de test (ex. lib.ioStub, _audit/e2e/lib.js) n'implémente
// pas forcément socketsLeave — no-op silencieux plutôt qu'un crash sur un appelant qui n'a de
// toute façon aucun socket réel à évincer.
function closeMissionChatRoom(io, missionId) {
  io?.socketsLeave?.(`mission:${missionId}`);
}

// Délai de grâce lecture seule sur le chat après clôture (2026-07-31) — voir schema.js
// (colonne missions.closed_at, posée par transitionMission à chaque transition vers
// completed/cancelled) et prompt de session dédié. N'affecte QUE la lecture : l'envoi
// reste bloqué immédiatement à la clôture (POST /:id/messages, inchangé) et la room
// socket reste fermée immédiatement aussi (closeMissionChatRoom ci-dessus, inchangé).
const CHAT_READ_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

// Calcule la date de fin de grâce à exposer en API — null tant que la mission n'a
// jamais été close, ET si elle a été rouverte depuis (sous_reclamation) : closed_at
// n'est alors qu'un vestige de la clôture précédente, pas la limite de lecture en
// vigueur (voir transitionMission — closed_at n'est jamais effacé sur réouverture,
// seulement réécrit à la prochaine (re)clôture). Le frontend n'a ainsi qu'à tester la
// présence de ce champ, sans dupliquer la règle "completed/cancelled uniquement" ni la
// durée de 24h.
function chatAccessExpiresAt(mission) {
  if (!mission.closed_at || !['completed', 'cancelled'].includes(mission.status)) return null;
  return new Date(new Date(mission.closed_at).getTime() + CHAT_READ_GRACE_PERIOD_MS).toISOString();
}

// ── Réutilisable : validation + tarification d'une soumission de formulaire mission ──
// Extrait de POST /missions pour être partagé avec POST /payments/payzone/init
// (routes/payments.js — paiement PayZone). Ne fait AUCUNE écriture DB (uniquement des
// lectures pour validation) — retourne { error } ou { insert, freePromo } prêts pour
// insertMissionRecord ci-dessous. Comportement strictement identique à l'ancien code
// inline de POST /missions.
async function prepareMissionInsert(db, clientId, body, opts = {}) {
  const {
    type, title, description, address, city, quartier, scheduled_at,
    duration_est, price, is_urgent, oeil_id,
    property_type, visit_type, video_call,
    institution, purpose,
    company_name, audit_type, frequency, criteria, subcategory,
    promo_code, discount,
    replacement_preference,
  } = body;

  // Modèle de paiement cash (2026-08-13) — voir schema.js (missions.payment_method) et
  // RAPPORT_DIAGNOSTIC_COHERENCE_CASH_VS_PAYZONE.md. Obligatoire, aucune valeur par défaut
  // implicite : une mission payante doit toujours déclarer explicitement qui encaisse.
  // opts.forcedPaymentMethod : réservé à POST /payments/payzone/init (routes/payments.js), qui
  // n'a jamais demandé ce champ au client et ne doit pas commencer à l'exiger maintenant — le
  // choix 'payzone' y est déjà déterminé sans ambiguïté par la route elle-même. Sans cet opt,
  // ce chemin recevrait 400 pour un champ qu'aucun appelant existant n'envoie, ce qui romprait
  // "payzone reste identique au bit près" (garde-fou explicite de la session). Pour POST
  // /missions (aucun opt fourni), la valeur vient uniquement de body.payment_method.
  const paymentMethod = opts.forcedPaymentMethod || body.payment_method;
  if (!['cash', 'payzone'].includes(paymentMethod)) {
    return { error: "payment_method invalide ou manquant (attendu : 'cash' ou 'payzone')" };
  }

  const cityCheck = validateCityInput(city);
  if (cityCheck.error) return { error: cityCheck.error };
  const canonicalCity = cityCheck.city;
  let canonicalQuartier = null;
  if (quartier) {
    canonicalQuartier = resolveQuartier(canonicalCity, quartier);
    if (!canonicalQuartier) return { error: 'Quartier invalide pour cette ville' };
  }
  if (subcategory && !isValidSubcategory(type, subcategory)) {
    return { error: 'Sous-catégorie invalide pour ce type de mission' };
  }

  // oeil_id fourni par le client (réservation directe depuis sa fiche) — jamais fait confiance
  // sans revalidation serveur (audit croisé 2026-07-26, Partie E ; commit 25d88be). Logique
  // désormais partagée avec hireOeilCore et POST /:id/assign-admin via checkOeilAssignable
  // (extraction 2026-07-27, Partie F) — comportement strictement inchangé ici : pas d'override
  // pour ce point d'entrée, pas de mission existante à exclure du conflit de créneau.
  if (oeil_id) {
    const assignCheck = await checkOeilAssignable(db, oeil_id, { scheduledAt: scheduled_at });
    if (assignCheck.error) return { error: assignCheck.error };
  }

  // Commission/oeil_earning TOUJOURS calculés sur price (le montant réellement facturé/
  // enregistré), jamais sur un original_price envoyé par le client. original_price n'est
  // qu'un affichage côté frontend (POST /promo/validate) — avant ce correctif, un client
  // pouvait l'envoyer arbitrairement élevé (avec ou sans promo_code réel, y compris à
  // price>0) et se faire créditer un oeil_earning sans rapport avec ce qu'il paie
  // réellement (constaté : price=1, original_price=99999 → oeil crédité ~79999 MAD à la
  // validation). Le cas gratuit (price=0 + promo réel) reste géré séparément ci-dessous,
  // avec platform_amount — jamais une valeur cliente.
  let { commission, oeil_earning } = await pricing(+price, db);

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
      return { error: 'Code promo invalide pour une mission gratuite' };
    }
    if (p.expires_at && new Date(p.expires_at) < new Date()) {
      return { error: 'Code promo expiré' };
    }
    if (p.max_uses && p.used_count >= p.max_uses) {
      return { error: 'Code promo épuisé' };
    }
    const { rows: [usage] } = await db.query(
      `SELECT COUNT(*)::int AS n FROM promo_uses WHERE promo_id=$1 AND user_id=$2`, [p.id, clientId]
    );
    if (usage.n >= p.max_uses_per_user) {
      return { error: 'Vous avez déjà utilisé ce code' };
    }
    if (!p.platform_amount) {
      return { error: "Ce code promo n'a pas de montant configuré" };
    }
    freePromo = p;
    oeil_earning = parseFloat(p.platform_amount);
    commission = 0;
  }

  // Plancher tarifaire serveur (POINT 3 audit sécurité global 08-09) — jusqu'ici min_price
  // existait en base (settings, seedé à 80 MAD) sans être lu par aucune logique métier ; seule
  // la validation structurelle isFloat({min:0}) s'appliquait (missionCreateValidators),
  // acceptant n'importe quel prix >= 0. Exempté pour une mission gratuite via code promo déjà
  // validée ci-dessus (freePromo non-null) : ce 0 MAD est volontaire, ce n'est pas un tarif
  // client à plancher.
  if (!freePromo) {
    const minPrice = await getSetting(db, 'min_price', 80);
    if (+price < minPrice) return { error: `Le prix minimum est de ${minPrice} MAD` };
  }

  // Réservation directe cash (oeil_id fourni à la création) : seul point d'affectation où un
  // Œil est attaché à la mission AVANT que celle-ci existe, donc AVANT que mission.commission
  // soit une colonne lisible — on vérifie ici sur la valeur locale `commission` fraîchement
  // calculée ci-dessus (identique à ce que la ligne aurait une fois insérée). N'exécute jamais
  // rien pour 'payzone' (checkCashCommissionBalance court-circuite déjà sur commission<=0, mais
  // la garde explicite ci-dessous documente l'intention et évite un appel DB inutile pour le cas
  // de très loin le plus fréquent).
  if (oeil_id && paymentMethod === 'cash') {
    const balanceCheck = await checkCashCommissionBalance(db, oeil_id, commission);
    if (balanceCheck.error) return { error: balanceCheck.error };
  }

  const status = oeil_id ? 'assigned' : 'pending';

  return {
    insert: {
      type, title, description, address, city: canonicalCity, quartier: canonicalQuartier, scheduled_at,
      duration_est, price, commission, oeil_earning, is_urgent, oeil_id,
      property_type, visit_type, video_call, institution, purpose,
      company_name, audit_type, frequency, criteria, subcategory,
      promo_code, discount, replacement_preference, status, payment_method: paymentMethod,
    },
    freePromo,
  };
}

// ── Réutilisable : écriture DB de la mission + effets de bord synchrones (dépense promo
// gratuite, historique de statut, usage du code promo) — PAS de notifications ici (règle du
// projet : jamais de notify() dans une transaction, voir POST /:id/validate plus haut).
// `db` peut être le pool (getDb()) ou un client déjà en transaction (walletService.
// withTransaction), selon l'appelant — POST /missions passe le pool (comportement inchangé),
// le callback PayZone passe un client de transaction (voir routes/payments.js).
async function insertMissionRecord(db, clientId, insertData, freePromo) {
  const {
    type, title, description, address, city, quartier, scheduled_at,
    duration_est, price, commission, oeil_earning, is_urgent, oeil_id,
    property_type, visit_type, video_call, institution, purpose,
    company_name, audit_type, frequency, criteria, subcategory,
    promo_code, discount, replacement_preference, status, payment_method,
  } = insertData;

  const id = uuidv4();
  const { rows: [mission] } = await db.query(`
    INSERT INTO missions (
      id,client_id,type,subcategory,status,title,description,address,city,quartier,scheduled_at,
      duration_est,price,commission,oeil_earning,is_urgent,
      property_type,visit_type,video_call,institution,purpose,
      company_name,audit_type,frequency,criteria,oeil_id,replacement_preference,payment_method
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
    RETURNING *
  `, [
    id, clientId, type, subcategory||null, status, title, description||null, address, city, quartier,
    new Date(scheduled_at), duration_est||null, price, commission, oeil_earning,
    !!is_urgent, property_type||null, visit_type||null, !!video_call,
    institution||null, purpose||null, company_name||null, audit_type||null,
    frequency||null, criteria||null, oeil_id||null, replacement_preference || 'fast', payment_method
  ]);

  // Mission offerte via code promo gratuit : Shoofly paie l'Œil de sa poche, sans commission générée.
  // On enregistre ce coût comme une dépense pour qu'il reste visible dans le Dashboard Financier.
  // Montant = freePromo.platform_amount (validé côté serveur dans prepareMissionInsert), jamais une valeur cliente.
  if (freePromo) {
    await db.query(
      `INSERT INTO expenses (amount, category, description, expense_date, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [freePromo.platform_amount, 'Promotions', `[Généré automatiquement] Mission offerte "${title}" — code promo ${freePromo.code}`, new Date().toISOString().slice(0, 10), null]
    );
  }

  await logStatus(db, mission.id, 'pending', clientId, 'Mission créée');

  if (promo_code) {
    const { rows: [promo] } = await db.query(
      `SELECT id FROM promo_codes WHERE UPPER(code)=UPPER($1)`, [promo_code]
    );
    if (promo) {
      await db.query(
        `INSERT INTO promo_uses (promo_id, user_id, mission_id, discount) VALUES ($1,$2,$3,$4)`,
        [promo.id, clientId, mission.id, discount || 0]
      );
      await db.query(
        `UPDATE promo_codes SET used_count=used_count+1 WHERE id=$1`, [promo.id]
      );
    }
  }

  return mission;
}

// ── Réutilisable : vague WhatsApp pour une mission urgente — appelée à la création (voir
// notifyNewMission ci-dessous, mission.is_urgent) ET par le cron de vagues suivantes (index.js).
// Contacte au plus urgent_mission_whatsapp_batch_size Œils éligibles (disponibles, vérifiés,
// même ville que la mission) PAS ENCORE contactés pour cette mission précise (table dédiée
// mission_whatsapp_contacts — anti-doublon), classés reliability_score DESC, rating_avg DESC
// (même principe que advanceCandidateCascade, sans réutiliser mission_interests : ici personne
// n'a encore postulé, c'est le pool des Œils disponibles de la ville, pas des candidats).
// Programme la vague suivante (missions.urgent_whatsapp_next_wave_at) si le pool n'est pas
// épuisé ; sinon laisse le champ à NULL — l'alerte admin "mission sans Œil depuis 12h" déjà
// existante (index.js, cronStaleMissionsRunning) prend le relais, aucune nouvelle logique de
// repli à construire ici (garde-fou explicite de la spec).
async function sendUrgentWhatsAppWave(db, mission) {
  const batchSize = await getSetting(db, 'urgent_mission_whatsapp_batch_size', 10);
  const delayMinutes = await getSetting(db, 'urgent_mission_whatsapp_batch_delay_minutes', 30);

  const { rows: pool } = await db.query(
    `SELECT u.id, u.phone FROM users u JOIN oeil_profiles p ON p.user_id=u.id
     WHERE u.role='oeil' AND u.is_active=true AND u.is_suspended=false AND p.is_verified=true AND p.is_available=true
       AND u.city=$1
       AND u.id NOT IN (SELECT oeil_id FROM mission_whatsapp_contacts WHERE mission_id=$2)
     ORDER BY u.reliability_score DESC, p.rating_avg DESC
     LIMIT $3`,
    [mission.city, mission.id, batchSize]
  );

  for (const o of pool) {
    await db.query(
      `INSERT INTO mission_whatsapp_contacts (mission_id, oeil_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [mission.id, o.id]
    );
    if (o.phone) {
      await sendWhatsAppTemplate(waselTemplates.urgent_mission_whatsapp_wave.template_name, o.phone, [mission.title, `${mission.price} MAD`]);
    } else {
      console.warn(`[wasel] Œil ${o.id} sans téléphone renseigné — envoi ignoré (urgent-mission-wave)`);
    }
  }

  // Reste-t-il des Œils éligibles non encore contactés ? Si oui, vague suivante programmée ;
  // sinon pool épuisé, on ne programme rien de plus (voir garde-fou ci-dessus).
  const { rows: [{ n: remaining }] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM users u JOIN oeil_profiles p ON p.user_id=u.id
     WHERE u.role='oeil' AND u.is_active=true AND u.is_suspended=false AND p.is_verified=true AND p.is_available=true
       AND u.city=$1
       AND u.id NOT IN (SELECT oeil_id FROM mission_whatsapp_contacts WHERE mission_id=$2)`,
    [mission.city, mission.id]
  );

  // Garde oeil_id IS NULL : évite d'écraser/reprogrammer une vague sur une mission qui vient
  // d'être assignée par un autre chemin pendant l'envoi de cette vague (même esprit que la
  // garde optimiste WHERE status='pending' AND oeil_id IS NULL d'advanceCandidateCascade).
  await db.query(
    `UPDATE missions SET urgent_whatsapp_next_wave_at=$1 WHERE id=$2 AND oeil_id IS NULL`,
    [remaining > 0 ? new Date(Date.now() + delayMinutes * 60 * 1000) : null, mission.id]
  );

  return pool.length;
}

// ── Réutilisable : notifications + broadcast admin après création — JAMAIS à l'intérieur
// d'une transaction. Identique que la mission vienne d'une création directe (POST /missions)
// ou d'un paiement PayZone confirmé (POST /payments/payzone/callback).
async function notifyNewMission(db, mission, emitToUser, io) {
  const { rows: oeils } = await db.query(
    `SELECT u.id FROM users u JOIN oeil_profiles p ON p.user_id=u.id
     WHERE u.role='oeil' AND u.is_active=true AND u.is_suspended=false AND p.is_verified=true AND p.is_available=true
       AND u.city=$1`,
    [mission.city]
  );
  for (const o of oeils) {
    await notify(db, o.id, `Nouvelle mission${mission.is_urgent?' 🚨 URGENTE':''}`,
      `${mission.title} — ${mission.city} · ${mission.price} MAD`, 'mission', mission.id, emitToUser, null,
      mission.is_urgent ? 'newMissionUrgentTitle' : 'newMissionAvailableTitle', 'newMissionBody',
      { missionTitle: mission.title, city: mission.city, price: mission.price });
  }
  if (io) io.to('room:admin').emit('new_mission', mission);

  // WhatsApp (facturé par Wasel) : jamais à tous les Œils en une fois pour une mission urgente —
  // par vagues seulement, voir sendUrgentWhatsAppWave ci-dessus. Missions non urgentes : aucun
  // WhatsApp ici (comportement inchangé — seule la notification in-app ci-dessus existait déjà).
  if (mission.is_urgent) {
    await sendUrgentWhatsAppWave(db, mission);
  }
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

  // Toutes les écritures interdépendantes (validated_at, chaîne de transfert, crédit(s)/débit
  // wallet, ledger, historique) dans une seule transaction — avant ce correctif, un crash
  // entre deux de ces étapes pouvait laisser une mission "validée" sans que le paiement
  // correspondant ait été appliqué (ou l'inverse). partialPayments accumule les paiements
  // au prorata pour notifier APRÈS le commit (jamais de notify() dans la transaction).
  const partialPayments = [];
  // Rempli uniquement pour payment_method='cash' (voir bloc cash ci-dessous) — sert au choix du
  // message post-commit (débit affiché, jamais "crédité").
  let cashSettlement = null;
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

      if (mission.payment_method === 'payzone') {
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
      } else {
        // Mission cash (2026-08-13) : le client a déjà payé l'Œil directement en espèces — pas
        // de crédit d'oeil_earning (peu importe transfer_type — voir settleCashCommission pour
        // la justification de débiter mission.oeil_id, l'Œil qui détient la mission au moment de
        // la validation, plutôt qu'un split au prorata de la chaîne : la commission est un
        // montant unique par mission, pas par tronçon, et chaque Œil de la chaîne a déjà été
        // vérifié individuellement contre ce même montant à son affectation, voir hireOeilCore).
        // Ferme quand même la chaîne de transfert (ended_at) pour laisser un historique cohérent,
        // même si earning_share n'a aucun sens à calculer ici (rien n'est crédité).
        if (mission.transfer_type === 'during') {
          await client.query(
            `UPDATE mission_transfer_chain SET ended_at=NOW() WHERE mission_id=$1 AND ended_at IS NULL`,
            [mission.id]
          );
        }
        cashSettlement = await settleCashCommission(client, mission, 'Commission Shoofly — mission cash (validation client)');
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
  if (cashSettlement) {
    await notify(db, mission.oeil_id, '✅ Mission validée', `Le client a validé "${mission.title}". ${cashSettlement.collected} MAD de commission débités de votre wallet (mission cash).`, 'info', mission.id, emitToUser, null, 'commissionDebitedOeilTitle', 'commissionDebitedOeilBody', {missionTitle: mission.title, amount: cashSettlement.collected});
  } else {
    await notify(db, mission.oeil_id, '💰 Paiement reçu !', `Le client a validé "${mission.title}". ${mission.oeil_earning} MAD crédités.`, 'info', mission.id, emitToUser, null, 'paymentReceivedOeilTitle', 'paymentReceivedOeilBody', {missionTitle: mission.title, amount: mission.oeil_earning});
  }
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
      m.id, m.title, m.type, m.status, m.closed_at,
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

  // Route intrinsèquement client/Œil (WHERE client_id=$1 OR oeil_id=$1 ci-dessus, jamais
  // admin) — pas de garde isAdmin nécessaire ici, contrairement à GET /:id. last_message est
  // un aperçu du CONTENU du dernier message : même règle que messages/media sur GET /:id,
  // sous peine de laisser fuir par un autre chemin exactement ce que le délai de grâce est
  // censé fermer.
  rows.forEach(m => {
    m.chat_access_expires_at = chatAccessExpiresAt(m);
    if (m.chat_access_expires_at !== null && Date.now() > new Date(m.chat_access_expires_at).getTime()) {
      m.last_message = null;
    }
  });
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
    // Même règle que canSeeChat (GET /:id) — voir sa justification là-bas (POINT 2 audit
    // sécurité global 08-09). role==='client' est sûr ici : le WHERE ci-dessus filtre déjà
    // cette liste sur m.client_id=req.user.id pour ce rôle, chaque ligne lui appartient.
    if (!(req.user.role === 'admin' || req.user.role === 'client' || m.oeil_id === req.user.id)) {
      m.transfer_reason = null;
      m.transferred_from = null;
    }
    m.chat_access_expires_at = chatAccessExpiresAt(m);
  });
  res.json({ missions, total, page: +page, pages: Math.ceil(total / limit) });
}));

// Rate limit dédié sur la création de mission — 10 missions / 15min par IP,
// en plus du plafond global déjà appliqué à toutes les routes (index.js).
const missionCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de missions créées depuis cette adresse. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Anti-double-création (PROMPT 1 point 4, 2026-08-17) ────────────────────
// missionCreateLimiter ci-dessus throttle le volume (10/15min) mais ne dédoublonne rien : deux
// requêtes quasi simultanées (double-clic, retry réseau du frontend) passent toutes les deux le
// rate limit et créeraient deux missions identiques. Empreinte déterministe sur les champs
// normalisés qui définissent une création "identique" du point de vue utilisateur — oeil_id
// inclus (une réservation directe et une recherche ouverte sur le même créneau/adresse ne sont
// pas la même création) ; commission/oeil_earning volontairement exclus (dérivés de price, ne
// peuvent pas différer pour un price identique). Voir mission_create_locks (db/schema.js) pour
// la garde d'unicité réellement posée par Postgres — cette fonction ne fait que calculer la clé.
function missionCreateFingerprint(insert) {
  const parts = [
    insert.type, (insert.title || '').trim(), (insert.address || '').trim(),
    insert.city, insert.quartier, new Date(insert.scheduled_at).toISOString(),
    insert.duration_est ?? null, +insert.price, insert.oeil_id || null,
    insert.subcategory || null, insert.payment_method,
  ];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
// Fenêtre de déduplication — largement suffisante pour absorber un double-clic ou un retry réseau,
// assez courte pour ne jamais gêner une resoumission volontaire après correction d'une erreur.
const MISSION_CREATE_LOCK_WINDOW_SECONDS = 15;

// Réutilisé par POST /payments/payzone/init (routes/payments.js — paiement PayZone) :
// mêmes règles de validation structurelle qu'à la création directe d'une mission.
const missionCreateValidators = [
  body('type').isIn(['immobilier','file_attente','audit','personnalisee']),
  body('title').trim().isLength({ min: 6, max: 200 }),
  body('address').trim().notEmpty(),
  body('city').trim().notEmpty(),
  body('scheduled_at').isISO8601(),
  body('price').isFloat({ min: 0 }),
  body('replacement_preference').optional().isIn(['fast','choose']),
];

// ── POST /missions ─────────────────────────────────────────
router.post('/', missionCreateLimiter, authenticate, requireRole('client'), missionCreateValidators, asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  const { error, insert, freePromo } = await prepareMissionInsert(db, req.user.id, req.body);
  if (error) return res.status(400).json({ error });

  // Création directe réservée aux missions gratuites (price=0, promo 'free' ou aucune) et,
  // depuis le modèle cash (2026-08-13), à toute mission payment_method='cash' — le client y
  // paie l'Œil directement en espèces, il n'y a donc rien à faire encaisser à Shoofly avant
  // création (voir prepareMissionInsert pour la vérification de solde wallet côté Œil, quand un
  // oeil_id est fourni). Pour payment_method='payzone', comportement STRICTEMENT inchangé :
  // toute mission payante doit passer par POST /payments/payzone/init, seule voie qui collecte
  // réellement le paiement. Sans cette garde, un client pouvait appeler cette route directement
  // (hors frontend) avec un price>0 et obtenir une mission réelle, assignable et payant l'Œil,
  // sans jamais payer quoi que ce soit.
  if (+insert.price > 0 && insert.payment_method !== 'cash') {
    return res.status(400).json({ error: 'Paiement requis pour cette mission — utilisez POST /payments/payzone/init.' });
  }

  // Anti-double-création : verrou posé sur l'INSERT lui-même via la contrainte UNIQUE
  // (client_id, fingerprint) de mission_create_locks — seule garde réellement sûre sous requêtes
  // concurrentes (un SELECT préalable laisserait une fenêtre de course ouverte entre les deux
  // requêtes d'un double-clic). Nettoyage paresseux de cette clé précise avant tentative : une
  // même empreinte redevient réutilisable passé la fenêtre, sans cron de purge dédié.
  const fingerprint = missionCreateFingerprint(insert);
  await db.query(
    `DELETE FROM mission_create_locks WHERE client_id=$1 AND fingerprint=$2 AND created_at < NOW() - ($3 * INTERVAL '1 second')`,
    [req.user.id, fingerprint, MISSION_CREATE_LOCK_WINDOW_SECONDS]
  );
  const { rowCount: lockAcquired } = await db.query(
    `INSERT INTO mission_create_locks (client_id, fingerprint) VALUES ($1,$2) ON CONFLICT (client_id, fingerprint) DO NOTHING`,
    [req.user.id, fingerprint]
  );
  if (lockAcquired === 0) {
    return res.status(409).json({ error: 'Cette mission est déjà en cours de création, merci de patienter quelques secondes.' });
  }

  const mission = await insertMissionRecord(db, req.user.id, insert, freePromo);

  await db.query(`UPDATE mission_create_locks SET mission_id=$1 WHERE client_id=$2 AND fingerprint=$3`, [mission.id, req.user.id, fingerprint]);

  await notifyNewMission(db, mission, emitToUser, io);

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
    const cityCheck = validateCityInput(body.city);
    if (cityCheck.error) return { error: cityCheck.error };
    changes.city = cityCheck.city;
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

  // type/subcategory : jamais atteints par le client (bloqués en amont par FORBIDDEN_EDIT_FIELDS
  // sur PUT /:id) — n'existent ici que pour PUT /:id/admin-edit (Super Admin, PROMPT 1 point 2,
  // 2026-08-17), qui appelle cette même fonction pour rester sur une seule et unique règle de
  // validation entre les deux routes.
  if ('type' in body) {
    if (!['immobilier', 'file_attente', 'audit', 'personnalisee'].includes(body.type)) {
      return { error: 'Type de mission invalide' };
    }
    changes.type = body.type;
  }
  if ('subcategory' in body) {
    const typeForSubcategory = changes.type || mission.type;
    if (body.subcategory && !isValidSubcategory(typeForSubcategory, body.subcategory)) {
      return { error: 'Sous-catégorie invalide pour ce type de mission' };
    }
    changes.subcategory = body.subcategory || null;
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

// ── PUT /missions/:id/admin-edit ── Super Admin édite une mission (tous champs sauf price) ──
// (PROMPT 1 point 2, 2026-08-17). price reste verrouillé pour TOUT rôle, y compris Super Admin :
// la commission (et, en cash, le blocage de solde sur le wallet Œil via checkCashCommissionBalance
// à l'affectation) est calculée une seule fois à la création à partir de price et n'est jamais
// recalculée après coup (voir pricing(), prepareMissionInsert plus haut) — un price modifiable
// romprait cette cohérence financière déjà construite. Aucune restriction de statut ici (pas
// demandée) : un Super Admin peut corriger une mission quel que soit son statut. Toute édition est
// tracée dans mission_admin_edits (qui/quoi/quand, avant/après par champ — voir db/schema.js).
router.put('/:id/admin-edit', authenticate, requireRole('admin'), requireSuperAdmin, asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');

  if ('price' in req.body) {
    return res.status(400).json({ error: 'Le prix est verrouillé après création, y compris pour le Super Admin.' });
  }

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  const { error, changes } = validateMissionEditFields(req.body, mission);
  if (error) return res.status(400).json({ error });
  if (Object.keys(changes).length === 0) return res.status(400).json({ error: 'Aucun champ à modifier' });

  // Avant/après par champ, capturé sur la ligne encore non modifiée — from doit refléter la valeur
  // réellement remplacée, jamais une reconstruction après l'UPDATE.
  const auditChanges = {};
  for (const key of Object.keys(changes)) {
    auditChanges[key] = { from: mission[key], to: changes[key] };
  }

  const updated = await applyMissionEditChanges(db, mission.id, changes);

  await db.query(
    `INSERT INTO mission_admin_edits (mission_id, admin_id, changes) VALUES ($1,$2,$3)`,
    [mission.id, req.user.id, JSON.stringify(auditChanges)]
  );

  // Notification in-app uniquement, même choix que POST /edit-requests/:id/cancel plus haut (pas
  // de nouveau template WhatsApp, pas de title_key/body_key sans traduction frontend correspondante
  // — chantier backend seul).
  await notify(db, mission.client_id, 'Mission modifiée',
    `Un administrateur a modifié les informations de votre mission "${updated.title}".`,
    'mission', mission.id, emitToUser);
  if (mission.oeil_id) {
    await notify(db, mission.oeil_id, 'Mission modifiée',
      `Un administrateur a modifié les informations de la mission "${updated.title}".`,
      'mission', mission.id, emitToUser);
  }

  io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status: updated.status });
  io.to('room:admin').emit('mission_updated', updated);

  res.json({ mission: updated, changes: auditChanges });
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

  // Délai de grâce avant filet de sécurité (checkTransferDeadlines) — même réglages que
  // /transfer, checkPresenceConfirmationDeadlines, etc. (RAPPORT_DIAGNOSTIC_REFUS_EDIT_REQUEST.md).
  const graceMinutesQueue = await getSetting(db, 'transfer_grace_minutes_queue', 45);
  const graceMinutesOther = await getSetting(db, 'transfer_grace_minutes_other', 60);
  const graceMinutes = mission.type === 'file_attente' ? graceMinutesQueue : graceMinutesOther;
  const deadline = new Date(Date.now() + graceMinutes * 60 * 1000);

  let updatedMission;
  try {
    updatedMission = await transitionMission(db, mission.id, 'assigned', 'pending', req.user.id, {
      extraFields: { oeil_id: null, is_priority: true, transfer_deadline: deadline },
      note: 'Demande de modification refusée par l\'Œil',
    });
  } catch (e) {
    if (e instanceof MissionTransitionError) return res.status(409).json({ error: e.message });
    throw e;
  }

  // Supprime la propre candidature de l'Œil sur cette mission — sans ça, le cron de sélection
  // automatique pourrait le réassigner à la mission qu'il vient de refuser (même correctif que
  // POST /:id/transfer, ligne ~1813, et checkPresenceConfirmationDeadlines).
  await db.query(`DELETE FROM mission_interests WHERE mission_id=$1 AND oeil_id=$2`, [mission.id, req.user.id]);

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

  // Relance la cascade de réattribution — alignement sur les 5 autres chemins qui remettent une
  // mission en pending (POST /:id/refuse, POST /:id/transfer, désactivation admin, blocage
  // anti-fraude, checkPresenceConfirmationDeadlines). transfer_type/transferred_from restent
  // volontairement NULL (contrairement à ces 5 chemins) : les poser armerait la pénalité de
  // fiabilité -10 de checkTransferDeadlines (branche transfer_type==='before') si aucun
  // remplaçant n'est trouvé avant l'échéance — contraire à la règle explicite ci-dessus
  // ("SANS pénalité ... ni une annulation ni un abandon").
  await advanceCandidateCascade(db, io, emitToUser, updatedMission, {});

  res.json({ mission: updatedMission, edit_request: { ...editRequest, status: 'rejected' } });
}));

// ── POST /missions/edit-requests/:id/cancel ── Le client retire sa propre demande ──
// (PROMPT 1 point 1, 2026-08-17). Distinct de /reject (Œil) et de l'expiration (cron) : ici
// c'est l'auteur de la demande qui se rétracte, tant que l'Œil n'a pas encore tranché. Aucun
// effet sur la mission elle-même (reste 'assigned', inchangée) — contrairement à /reject et à
// checkMissionEditRequestExpiry, qui remettent la mission en 'pending' : une demande retirée par
// son propre auteur avant toute réponse n'a jamais modifié quoi que ce soit à annuler.
router.post('/edit-requests/:id/cancel', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');

  const { rows: [editRequest] } = await db.query('SELECT * FROM mission_edit_requests WHERE id=$1', [req.params.id]);
  if (!editRequest) return res.status(404).json({ error: 'Demande de modification introuvable' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [editRequest.mission_id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });

  if (editRequest.status !== 'pending') return res.status(400).json({ error: 'Cette demande a déjà été traitée' });
  if (new Date(editRequest.expires_at) < new Date()) {
    return res.status(400).json({ error: "Le délai de réponse de l'Œil est expiré, cette demande ne peut plus être annulée." });
  }

  // Garde d'idempotence posée sur l'UPDATE lui-même (WHERE status='pending' AND expires_at>NOW()),
  // même principe que /approve, /reject et checkMissionEditRequestExpiry : si l'Œil vient de
  // répondre ou si le cron d'expiration vient de passer entre les vérifications ci-dessus et cet
  // UPDATE, rowCount=0 le révèle sans course possible.
  const { rowCount } = await db.query(
    `UPDATE mission_edit_requests SET status='cancelled', resolved_at=NOW() WHERE id=$1 AND status='pending' AND expires_at > NOW()`,
    [editRequest.id]
  );
  if (rowCount === 0) return res.status(409).json({ error: 'Cette demande a changé de statut entre-temps, veuillez rafraîchir.' });

  // Notification in-app uniquement — pas de template WhatsApp Wasel dédié à ce jour pour cet
  // événement (chantier backend seul, aucune soumission de nouveau template hors périmètre) ;
  // pas de title_key/body_key non plus, pour ne pas introduire une clé i18n sans traduction
  // frontend correspondante (shoofly-react hors périmètre de ce chantier).
  await notify(db, mission.oeil_id,
    'Modification retirée',
    `Le client a retiré sa demande de modification sur "${mission.title}".`,
    'mission', mission.id, emitToUser
  );

  res.json({ mission, edit_request: { ...editRequest, status: 'cancelled' } });
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

  mission.chat_access_expires_at = chatAccessExpiresAt(mission);

  // Délai de grâce dépassé : la mission continue de se charger normalement (titre/statut/
  // prix/note/rapport...) mais messages/media sont renvoyés vides pour client/Œil — admin
  // (MessagesSuspects.jsx, via ce même ChatModal.jsx partagé) toujours exempté, accès
  // illimité. report/rating restent hors de cette règle : ce ne sont pas des artefacts du
  // CHAT (mission_reports = rapport d'audit de l'Œil, ratings = note du client), aucun
  // rapport avec la conversation ou les photos qu'elle contient.
  const isAdmin = req.user.role === 'admin';
  const chatGraceExpired = !isAdmin && mission.chat_access_expires_at !== null
    && Date.now() > new Date(mission.chat_access_expires_at).getTime();

  // Le chat/média reste privé au client propriétaire, à l'Œil ACTUELLEMENT assigné et à
  // l'admin — indépendamment de la garde ci-dessus qui, elle, laisse volontairement tout
  // Œil consulter les détails publics (titre/prix/adresse...) d'une mission 'pending' pour
  // décider d'y candidater. Une mission repassée en pending (urgence, refus, expiration de
  // présence, suspension, blocage anti-fraude) garde l'historique de conversation/médias du
  // ou des Œil(s) précédent(s) — jamais purgé — qu'un Œil simplement candidat à la reprise
  // n'a aucune raison de voir (faille corrigée le 2026-08-09, cf. audit sécurité : upstream,
  // le seul garde-fou était `mission.status !== 'pending'`, sans lien avec l'appartenance).
  const canSeeChat = isAdmin || req.user.role === 'client' || mission.oeil_id === req.user.id;

  // transfer_reason/transferred_from révèlent qu'un collègue précédent a été bloqué/suspendu,
  // ou son motif d'urgence en texte libre — même cercle de confiance que canSeeChat ci-dessus
  // (POINT 2 audit sécurité global 08-09 : jusqu'ici exposés à tout Œil via SELECT m.*, y
  // compris un simple candidat à la reprise browsant le pool 'pending').
  if (!canSeeChat) {
    mission.transfer_reason = null;
    mission.transferred_from = null;
  }

  const [{ rows: [report] }, { rows: [rating] }] = await Promise.all([
    db.query('SELECT * FROM mission_reports WHERE mission_id=$1', [req.params.id]),
    db.query('SELECT * FROM ratings WHERE mission_id=$1', [req.params.id]),
  ]);

  let media = [];
  let messages = [];
  if (canSeeChat && !chatGraceExpired) {
    const [mediaRes, messagesRes] = await Promise.all([
      db.query('SELECT * FROM mission_media WHERE mission_id=$1 ORDER BY created_at DESC', [req.params.id]),
      db.query(`SELECT mm.*, u.first_name||' '||u.last_name AS sender_name, u.role AS sender_role
                FROM mission_messages mm JOIN users u ON u.id=mm.sender_id
                WHERE mm.mission_id=$1 ORDER BY mm.created_at ASC`, [req.params.id]),
    ]);
    media = mediaRes.rows;
    messages = messagesRes.rows;

    // Mark messages as read — sauté quand le chat est inaccessible (délai de grâce dépassé) :
    // rien n'est réellement vu par cet appel dans cette branche, pas de raison de marquer quoi
    // que ce soit lu.
    await db.query(`UPDATE mission_messages SET is_read=true WHERE mission_id=$1 AND sender_id!=$2`, [req.params.id, req.user.id]);
  }

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

  // Mission cash (2026-08-13) : ce chemin d'affectation n'appelait jusqu'ici aucun contrôle de
  // la famille checkOeilAssignable (déjà signalé, hors périmètre de ce correctif) — le solde
  // wallet doit néanmoins y être vérifié comme sur les 3 autres points d'affectation réels
  // (prepareMissionInsert, hireOeilCore, assign-admin), sans quoi un Œil pourrait contourner le
  // contrôle en acceptant directement plutôt qu'en passant par une candidature. N'exécute rien
  // pour 'payzone'.
  if (mission.payment_method === 'cash') {
    const balanceCheck = await checkCashCommissionBalance(db, req.user.id, mission.commission);
    if (balanceCheck.error) return res.status(400).json({ error: balanceCheck.error });
  }


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
          urgent_whatsapp_next_wave_at: null,
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

  const { rows: [clientContactAccept] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.client_id]);
  if (clientContactAccept?.phone) {
    await sendWhatsAppTemplate(waselTemplates.oeil_assigned_client.template_name, clientContactAccept.phone, [oeilName, mission.title]);
  }

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

    // Masquage strict côté client : une candidature dont l'Œil échoue une des 5
    // vérifications de checkOeilAssignable (vérifié/disponible/suspendu-bloqué/conflit de
    // créneau) est retirée avant la sérialisation — jamais de champ brut is_verified/
    // is_available/is_suspended/is_active/suspended_reason dans la réponse envoyée au client
    // (voir RAPPORT_GAP_BACKEND_MASQUAGE_ADMIN_OVERRIDE.md section 4 : la raison précise d'un
    // blocage est une information interne de fiabilité, non communicable au client, même via
    // un onglet réseau). L'admin, qui peut aussi consulter cette liste, garde la liste complète
    // et non filtrée — cet écran n'est pas celui visé par la règle badge/override (assign-admin).
    let visibleRows = rows;
    if (req.user.role === 'client') {
      const eligibility = await checkOeilsAssignableBulk(db, rows.map(o => o.id), {
        scheduledAt: mission.scheduled_at,
        excludeMissionId: mission.id,
      });
      visibleRows = rows.filter(o => eligibility[o.id]?.ok === true);
    }

    // Le client voit des tiers (Œils candidats) : masque la note d'un débutant
    // (< 10 missions) pour ne pas afficher un signal peu significatif.
    // L'admin, qui peut aussi consulter cette liste, garde la vraie valeur.
    // Le temps de réponse moyen est calculé en une seule requête groupée pour
    // tous les candidats (voir computeAvgResponseMinutesBulk) plutôt qu'en boucle.
    const avgResponseByOeil = await computeAvgResponseMinutesBulk(db, visibleRows.map(o => o.id));
    const newOeilThreshold = await getSetting(db, 'new_oeil_mission_threshold', 10);
    const interests = visibleRows.map(o => {
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
// Fermé pour l'Œil côté "mission assignée" (2026-07-28, correctif URGENCE/refuse) — défense en
// profondeur derrière le retrait du bouton "Refuser" côté frontend (session séparée) : le
// masquage à l'affichage seul n'est jamais suffisant sur ce projet. Seul appelant légitime
// identifié pour ce chemin était ce bouton précis (grep exhaustif routes+frontend, voir rapport) ;
// remplacé par POST /:id/assistance (urgence/mission), seul chemin restant pour un abandon avec
// recherche de remplaçant. La branche ignore=true (décliner une mission encore pending/
// disponible — boutons "Ignorer" de Missions.jsx/Dashboard.jsx) est un usage totalement distinct
// de la même URL et reste intentionnellement ouverte, inchangée ci-dessous.
router.post('/:id/refuse', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { ignore } = req.body;
  if (ignore) {
    // Mission disponible — juste ignorer
    await db.query(
      `INSERT INTO mission_ignored (oeil_id, mission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.id, req.params.id]
    );
    return res.json({ ok: true });
  }
  return res.status(403).json({ error: "Le refus direct d'une mission assignée n'est plus disponible. Utilisez \"Demander assistance\" pour signaler un empêchement ou une urgence." });
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
  if (['en_route', 'active', 'completed'].includes(status)) {
    if (req.user.role !== 'oeil' || mission.oeil_id !== req.user.id) {
      return res.status(403).json({ error: 'Seul l\'Œil assigné peut faire progresser la mission.' });
    }
  }

  // Annulation directe fermée pour l'Œil sur une mission déjà assignée/en_route/active — même
  // principe que la fermeture de /:id/refuse (e44af9f, 2026-07-28) : "Demander assistance"
  // doit rester le seul chemin normal pour un Œil qui ne peut/veut pas honorer une mission
  // déjà assignée (cherche un remplaçant), plutôt qu'une annulation sèche (remboursement
  // client 100%, aucune tentative de remplacement). Chemin confirmé par écrit le 2026-07-11
  // (1543ff2/f7db0cf) puis rouvert comme question par l'audit E2E du 07-28 (famille D,
  // #24bis) sans être tranché depuis — tranché ici. pending->cancelled non concerné : oeil_id
  // est toujours NULL tant que status='pending' (voir prepareMissionInsert), donc la garde
  // ligne 1231 bloque déjà systématiquement un Œil à ce stade, avant même ce filtre. Reste
  // ouvert pour le client sur ses propres missions à ces mêmes statuts (inchangé).
  if (status === 'cancelled' && req.user.role === 'oeil' && ['assigned', 'en_route', 'active'].includes(mission.status)) {
    return res.status(403).json({ error: 'L\'annulation directe d\'une mission assignée n\'est plus disponible pour l\'Œil. Utilisez "Demander assistance" pour signaler un empêchement ou une urgence.' });
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
    // Mission cash (2026-08-13) : Shoofly n'a jamais encaissé le client, quel que soit le
    // pourcentage demandé — aucun montant à rembourser. Vérifié avant la permission finance
    // ci-dessous : une règle d'intégrité financière absolue, indépendante de qui la demande.
    if (mission.payment_method === 'cash') {
      return res.status(400).json({ error: 'refund_percent indisponible sur une mission cash : Shoofly n\'a jamais encaissé le client, il n\'y a rien à rembourser.' });
    }
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
      const { points, reason, isGrave } = await computeLatePenalty(db, mission.scheduled_at, 'annulée par l\'Œil');
      await logReliabilityEvent(db, req.user.id, mission.id, points, reason, isGrave);
    }
    let refund;
    // Un admin peut fixer un pourcentage de remboursement précis, en dérogation à la règle automatique
    // (permission déjà vérifiée plus haut, avant l'UPDATE, pour ne jamais annuler sans pouvoir rembourser)
    if (req.user.role === 'admin' && req.body.refund_percent !== undefined) {
      const pct = Math.max(0, Math.min(parseFloat(req.body.refund_percent) || 0, 100));
      refund = Math.round(mission.price * pct / 100 * 100) / 100;
      if (refund > 0) {
        await walletService.credit(db, mission.client_id, 'client', refund, 'Remboursement — montant fixé par l\'administrateur', mission.id);
      }
      await notify(db, mission.client_id, '💰 Remboursement', `${refund} MAD crédités sur votre portefeuille suite à l'annulation de "${mission.title}".`, 'info', mission.id, emitToUser, null, 'fullRefundTitle', 'fullRefundBody', {amount: refund});
      if (mission.oeil_id) {
        await notify(db, mission.oeil_id, 'Mission annulée', `La mission "${mission.title}" a été annulée.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledByClientBody', {missionTitle: mission.title});
        const { rows: [oeilContactCancel1] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.oeil_id]);
        if (oeilContactCancel1?.phone) {
          await sendWhatsAppTemplate(waselTemplates.mission_cancelled_oeil.template_name, oeilContactCancel1.phone, [mission.title, 'Annulée par l\'administrateur']);
        }
      }
    } else {
      // Le client est traité comme "à l'origine" de l'annulation dans 2 cas :
      // 1) c'est lui-même qui annule, 2) un admin annule en précisant que la faute lui revient
      const initiatedByClient = req.user.role === 'client'
        || (req.user.role === 'admin' && req.body.client_at_fault === true);
      // Mission cash (2026-08-13) : refundOnCancellation n'est appelée QUE pour 'payzone' —
      // Shoofly n'a jamais encaissé le client d'une mission cash (il paie l'Œil directement en
      // espèces), donc "rembourser" n'a aucun sens ici. refund.js n'est jamais modifié ; seul ce
      // point d'appel est conditionné (garde-fou explicite de la session).
      refund = mission.payment_method === 'payzone'
        ? await refundOnCancellation(db, mission, initiatedByClient)
        : 0;

    if (mission.payment_method === 'cash') {
      // Aucun langage de remboursement pour cash, quel que soit initiatedByClient — Shoofly n'a
      // jamais rien encaissé à rendre. Même ventilation client/Œil que les branches payzone
      // ci-dessous (WhatsApp Œil inclus), seul le texte/la clé change.
      await notify(db, mission.client_id, 'Mission annulée', `"${mission.title}" a été annulée.`, 'info', mission.id, emitToUser, null, 'missionCancelledCashClientTitle', 'missionCancelledCashClientBody', {missionTitle: mission.title});
      // oeil_id !== req.user.id suffit à couvrir les 2 cas réunis ici (client/admin à l'origine :
      // toujours vrai, un client/admin n'est jamais l'oeil_id de la mission ; Œil à l'origine :
      // exclut sa propre notification, même logique que la branche admin/système ci-dessous).
      if (mission.oeil_id && mission.oeil_id !== req.user.id) {
        await notify(db, mission.oeil_id, 'Mission annulée', `La mission "${mission.title}" a été annulée.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledByClientBody', {missionTitle: mission.title});
        const { rows: [oeilContactCancelCash] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.oeil_id]);
        if (oeilContactCancelCash?.phone) {
          await sendWhatsAppTemplate(waselTemplates.mission_cancelled_oeil.template_name, oeilContactCancelCash.phone, [mission.title, 'Annulée']);
        }
      }
    } else if (initiatedByClient) {
      if (!mission.oeil_id) {
        await notify(db, mission.client_id, '💰 Remboursement intégral', `${refund} MAD crédités sur votre portefeuille.`, 'info', mission.id, emitToUser, null, 'fullRefundTitle', 'fullRefundBody', {amount: refund});
      } else if (refund > 0) {
        await notify(db, mission.client_id, '💰 Remboursement partiel', `${refund} MAD crédités sur votre portefeuille suite à l'annulation.`, 'info', mission.id, emitToUser, null, 'partialRefundTitle', 'partialRefundBody', {amount: refund});
      } else {
        await notify(db, mission.client_id, 'Mission annulée', `Annulation dans les 2h — aucun remboursement conformément aux CGV.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledNoRefundBody', null);
      }
      if (mission.oeil_id) {
        await notify(db, mission.oeil_id, 'Mission annulée', `La mission "${mission.title}" a été annulée par le client.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledByClientBody', {missionTitle: mission.title});
        const { rows: [oeilContactCancel2] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.oeil_id]);
        if (oeilContactCancel2?.phone) {
          await sendWhatsAppTemplate(waselTemplates.mission_cancelled_oeil.template_name, oeilContactCancel2.phone, [mission.title, 'Annulée par le client']);
        }
      }
    } else {
      await notify(db, mission.client_id, '💰 Remboursement intégral', `${refund} MAD crédités sur votre portefeuille suite à l'annulation de "${mission.title}".`, 'info', mission.id, emitToUser, null, 'fullRefundTitle', 'fullRefundBody', {amount: refund});
      if (mission.oeil_id && mission.oeil_id !== req.user.id) {
        await notify(db, mission.oeil_id, 'Mission annulée', `La mission "${mission.title}" a été annulée.`, 'info', mission.id, emitToUser, null, 'missionCancelledByClientTitle', 'missionCancelledByClientBody', {missionTitle: mission.title});
        const { rows: [oeilContactCancel3] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.oeil_id]);
        if (oeilContactCancel3?.phone) {
          await sendWhatsAppTemplate(waselTemplates.mission_cancelled_oeil.template_name, oeilContactCancel3.phone, [mission.title, 'Annulée par l\'administrateur']);
        }
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

    // WhatsApp sur le numéro personnel du client — {{1}} nom de l'Œil, {{2}} titre de la mission.
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
  // Room fermée APRÈS la diffusion ci-dessus (ordre important, voir closeMissionChatRoom) :
  // les participants encore connectés reçoivent bien la bulle système de clôture avant d'être
  // évincés de la room.
  if (['completed', 'cancelled'].includes(status)) closeMissionChatRoom(io, mission.id);
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
  const result = await db.query(
    `UPDATE missions SET oeil_lat=$1, oeil_lng=$2, oeil_location_at=NOW() WHERE id=$3 AND oeil_id=$4`,
    [lat, lng, req.params.id, req.user.id]
  );
  // Ne diffuser que si la ligne a réellement été mise à jour (mission existante ET appelant
  // bien l'Œil assigné) — sinon n'importe quel Œil authentifié pouvait injecter de fausses
  // coordonnées GPS dans une room qui n'est pas la sienne, la mise à jour DB étant silencieuse
  // (0 ligne affectée) alors que la diffusion socket, elle, partait quand même.
  if (result.rowCount === 0) return res.status(403).json({ error: 'Accès refusé' });
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


// Détection de contenu sensible — module-level (pas nichée dans la route) pour être réutilisable
// par le handler socket send_message (index.js), qui doit appliquer exactement la même règle.
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

  // Chat fermé une fois la mission clôturée — sous_reclamation reste ouvert (litige en cours,
  // communication encore nécessaire) et tous les autres statuts sont inchangés. 400, pas
  // 403/409 : cohérent avec le reste du projet pour "action refusée à cause du statut actuel de
  // la mission" (ex. POST /api/media/:missionId, POST /:id/validate, /:id/claim — tous en 400
  // sur un blocage de statut ; 409 est réservé ici aux vraies courses de concurrence
  // optimistes). isAdmin exempté : MessagesSuspects.jsx (modération anti-fraude) réutilise
  // cette même route pour répondre à un message flaggé, y compris sur une mission déjà close —
  // accès volontairement inconditionnel pour ce rôle (voir
  // RAPPORT_DIAGNOSTIC_RAPPEL_CLIENT_ET_CHAT_MISSION.md §2.5, dernière ligne du tableau).
  if (!isAdmin && ['completed', 'cancelled'].includes(mission.status)) {
    return res.status(400).json({ error: 'Cette mission est clôturée, le chat n\'est plus disponible.' });
  }

const cleanContent = content.trim()

// Détection de contenu sensible (fonction module-level ci-dessus)
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

  const { rowCount: interestInsertCount } = await db.query(
    `INSERT INTO mission_interests (mission_id, oeil_id, message)
     VALUES ($1, $2, $3) ON CONFLICT (mission_id, oeil_id) DO NOTHING`,
    [req.params.id, req.user.id, message || null]
  );

  // Un retry (double-clic, ou nouvel essai après une erreur réseau qui masquait en fait un
  // succès) ne crée pas de 2e ligne (ON CONFLICT DO NOTHING ci-dessus) et ne doit donc
  // déclencher aucun effet de bord une 2e fois : ni notif client, ni recomptage du seuil
  // WhatsApp, ni relance de cascade — tout ce bloc ne réagit qu'à une candidature réellement
  // nouvelle.
  if (interestInsertCount > 0) {
    const emitToUser = req.app.get('emitToUser');
    const notifBody = `Un Œil est intéressé par votre mission : ${mission.title}`
    await notify(db, mission.client_id, 'Nouvel Œil intéressé 👁️', notifBody, 'interest', req.params.id, emitToUser, 'interests_modal', 'newOeilInterestTitle', 'newOeilInterestBody', {missionTitle: mission.title});

    // WhatsApp au client : jamais à chaque candidature individuelle — un seul envoi par
    // mission, déclenché dès que le nombre de candidatures d'Œils vérifiés atteint
    // candidature_whatsapp_seuil_count (défaut 3). Ne compte que les Œils avec oeil_profiles.
    // is_verified=true (audit sécurité post-chantiers, Partie D) : sinon plusieurs comptes
    // jetables non vérifiés peuvent forcer artificiellement l'envoi. Si ce seuil n'est jamais
    // atteint, le cron dédié (index.js) envoie après candidature_whatsapp_seuil_minutes depuis
    // la première candidature vérifiée. Garde atomique (UPDATE ... WHERE candidature_whatsapp_
    // sent_at IS NULL) pour éviter un double envoi si deux candidatures arrivent presque
    // simultanément.
    if (!mission.candidature_whatsapp_sent_at) {
      const seuilCount = await getSetting(db, 'candidature_whatsapp_seuil_count', 3);
      const { rows: [{ n: interestCount }] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM mission_interests mi
         JOIN oeil_profiles p ON p.user_id = mi.oeil_id AND p.is_verified = true
         WHERE mi.mission_id=$1`, [req.params.id]
      );
      if (interestCount >= seuilCount) {
        const { rowCount } = await db.query(
          `UPDATE missions SET candidature_whatsapp_sent_at=NOW() WHERE id=$1 AND candidature_whatsapp_sent_at IS NULL`,
          [req.params.id]
        );
        if (rowCount > 0) {
          const { rows: [clientContact] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.client_id]);
          if (clientContact?.phone) {
            await sendWhatsAppTemplate(waselTemplates.oeil_applied.template_name, clientContact.phone, [String(interestCount), mission.title]);
          }
        }
      }
    }

    // Relance la cascade de confirmation par lot si cette mission est en recherche élargie
    // (is_urgent, liste initiale épuisée) et qu'aucun lot n'est actuellement en cours (ni
    // fenêtre de lot, ni fenêtre de départage) — cette nouvelle candidature réactive le
    // mécanisme (voir point 8 de la spec réattribution / advanceCandidateCascade).
    if (mission.is_urgent && !isBatchLive(mission)) {
      const io = req.app.get('io');
      await advanceCandidateCascade(db, io, emitToUser, mission, {});
    }
  }

  res.status(201).json({ ok: true });
}));




// ── Réutilisable : libère une mission vers le pool de remplacement ────────
// À l'origine extraite de POST /:id/transfer pour être également réutilisée par le flux
// "Demander assistance" catégorie URGENCE (POST /:id/assistance) — les deux cas déclenchaient la
// même mécanique de fond (transitionMission + cooldown + advanceCandidateCascade), jamais une
// variante parallèle qui pourrait diverger silencieusement. Seule la pénalité de fiabilité (5pts,
// transfer_type='before') était rendue skippable via options.skipReliabilityPenalty — décision
// 2026-07-28 (correctif URGENCE) : un Œil qui déclare une urgence réelle ne doit pas voir son
// score baisser, contrairement à un transfert volontaire hors urgence (/transfer, qui ne passait
// jamais ce flag). Mise à jour 2026-07-30 (prompt 18) : /:id/transfer est désormais fermé pour
// l'Œil (403) — POST /:id/assistance{urgence} est le SEUL appelant HTTP restant de cette
// fonction, et passe systématiquement skipReliabilityPenalty:true. La branche par défaut
// (skipReliabilityPenalty=false, "pénalité conservée") est donc devenue INATTEIGNABLE depuis
// n'importe quelle route HTTP — code mort côté pénalité, laissé en l'état dans cette session
// (fermeture de route demandée, pas nettoyage de cette fonction partagée ; voir rapport). Le
// cooldown n'a PAS de flag équivalent : il est posé pour les deux transferType (4h si 'during'
// via transfer_cooldown_hours, ancré sur scheduled_at si 'before' via transfer_cooldown_before_hours
// — voir le commentaire détaillé au point où il est posé, plus bas) et s'applique sans bypass
// possible, y compris depuis le seul appelant restant. oeilId est passé explicitement (plutôt que
// lu sur req.user) pour rester appelable hors contexte HTTP direct.
async function releaseMissionForReplacement(db, io, emitToUser, mission, oeilId, reason, options = {}) {
  const {
    historyNoteVerb = "Empêchement signalé par l'Œil",
    clientAlertTitle = '⚠️ Changement sur votre mission',
    clientAlertBody = null,
    clientAlertTitleKey = 'missionChangeAlertTitle',
    clientAlertBodyKey = 'missionChangeAlertBody',
    systemMessageText = "L'Œil a signalé un empêchement. Mission remise en priorité.",
    systemMessageKey = 'missionImpediment',
    skipReliabilityPenalty = false,
  } = options;

  if (!['assigned', 'en_route', 'active'].includes(mission.status)) {
    return { ok: false, status: 400, error: 'Transfert impossible pour ce statut' };
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
    await transitionMission(db, mission.id, mission.status, 'pending', oeilId, {
      extraFields: {
        is_priority: true,
        transfer_type: transferType,
        transferred_from: oeilId,
        transfer_reason: reason,
        transfer_deadline: deadline,
        transfer_no_penalty: skipReliabilityPenalty,
        oeil_id: null,
      },
      extraGuards: { oeil_id: oeilId },
      note: `${historyNoteVerb} (${transferType === 'before' ? 'avant démarrage' : 'en cours de mission'})`,
    });
  } catch (e) {
    if (e instanceof MissionTransitionError) return { ok: false, status: 409, error: e.message };
    throw e;
  }

  // Supprime la propre candidature de l'Œil sur cette mission — sans ça, sa ligne
  // mission_interests (posée avant son embauche initiale) reste éligible et le cron de
  // sélection automatique (index.js, */2min) peut le réassigner lui-même à la mission
  // qu'il vient de signaler ne pas pouvoir honorer. Pour un transfert 'during', le cooldown
  // posé plus bas masque l'effet par accident ; pour 'before' (aucun cooldown posé), rien
  // d'autre ne l'empêchait — bug constaté empiriquement (audit scénario 2.9).
  await db.query(`DELETE FROM mission_interests WHERE mission_id=$1 AND oeil_id=$2`, [mission.id, oeilId]);

  // Transfert pendant mission : ferme la ligne active de la chaîne (le nouvel Œil n'est pas
  // encore connu à ce stade — la nouvelle ligne sera ouverte au moment où quelqu'un accepte
  // effectivement cette mission remise en file prioritaire).
  if (transferType === 'during') {
    await db.query(
      `UPDATE mission_transfer_chain SET ended_at=NOW() WHERE mission_id=$1 AND ended_at IS NULL`,
      [mission.id]
    );
  }
  // Cooldown — posé pour les deux transferType. 'during' garde ses 4h historiques
  // (transfer_cooldown_hours), ancrées sur l'instant du clic : la mission a déjà démarré, il n'y a
  // pas d'heure future à protéger.
  // 'before' est ANCRÉ SUR L'HEURE DE LA MISSION ABANDONNÉE, pas sur l'instant du clic (correctif
  // 2026-07-30, RAPPORT_COOLDOWN_BEFORE_ANCRAGE.md — remplace l'ancrage NOW() du correctif
  // 2026-07-28bis, RAPPORT_DIAGNOSTIC_TRANSFER.md). Ancrer sur NOW() laissait l'Œil annuler
  // suffisamment à l'avance (même plusieurs jours avant) pour que le cooldown expire bien avant
  // l'heure de la mission qu'il vient d'abandonner — aucune protection contre la substitution
  // opportuniste (repérer une mission Y mieux payée au même créneau que sa mission X assignée,
  // annuler X via URGENCE à l'avance, candidater sur Y une fois "now+2h" expiré). Formule :
  // ancre = MAX(scheduled_at - 1h, maintenant) ; transfer_cooldown_until = ancre +
  // transfer_cooldown_before_hours. Cas normal : fenêtre bloquée de 1h avant la mission jusqu'à
  // (transfer_cooldown_before_hours - 1h) après son heure prévue, peu importe quand l'Œil a
  // cliqué. Cas limite (mission déjà en retard au clic, scheduled_at-1h déjà dans le passé) :
  // ancre = maintenant, comportement identique à l'ancien calcul faute d'heure future à protéger.
  // Décision produit : appliqué aux deux appelants SANS exception, URGENCE compris — contrairement
  // à la pénalité de fiabilité ci-dessous (skipReliabilityPenalty), ce cooldown n'a pas de flag de
  // bypass : une indisponibilité réelle rend l'Œil temporairement indisponible pour de nouvelles
  // missions, urgence authentique ou non.
  if (transferType === 'during') {
    const transferCooldownHours = await getSetting(db, 'transfer_cooldown_hours', 4);
    await db.query(
      `UPDATE users SET transfer_cooldown_until=NOW() + INTERVAL '1 hour' * $2::numeric, transfer_count=transfer_count+1 WHERE id=$1`,
      [oeilId, transferCooldownHours]
    );
  } else {
    const transferCooldownBeforeHours = await getSetting(db, 'transfer_cooldown_before_hours', 3);
    await db.query(
      `UPDATE users SET
         transfer_cooldown_until = GREATEST($3::timestamptz - INTERVAL '1 hour', NOW()) + INTERVAL '1 hour' * $2::numeric,
         transfer_count = transfer_count + 1
       WHERE id=$1`,
      [oeilId, transferCooldownBeforeHours, mission.scheduled_at]
    );
  }

  // Pénalité fiabilité — sera recalculée précisément si pas de remplaçant (cron). Skippable
  // via options.skipReliabilityPenalty (URGENCE uniquement, voir commentaire de la fonction) —
  // /transfer ne passe jamais ce flag, donc son comportement reste strictement inchangé ici.
  if (transferType === 'before' && !skipReliabilityPenalty) {
    const transferBeforeReplacementBonusPoints = await getSetting(db, 'transfer_before_replacement_bonus_points', 5);
    await logReliabilityEvent(db, oeilId, mission.id, transferBeforeReplacementBonusPoints, 'Transfert avant démarrage avec remplaçant', false);
  }

  // Notifications
  await notify(db, mission.client_id,
    clientAlertTitle,
    clientAlertBody || `Votre Œil a signalé un empêchement pour "${mission.title}". Nous recherchons un remplaçant en urgence.`,
    'mission', mission.id, emitToUser, null, clientAlertTitleKey, clientAlertBodyKey, {missionTitle: mission.title}
  );

  // Message système dans le chat
  await db.query(
    `INSERT INTO mission_messages (mission_id,sender_id,content,type,content_key) VALUES ($1,$2,$3,'system',$4)`,
    [mission.id, oeilId, systemMessageText, systemMessageKey]
  );

  if (io) {
    io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status: 'pending' });
    io.to('room:admin').emit('mission_updated', { id: mission.id, is_priority: true });
  }

  // Lance la cascade de confirmation séquentielle sur le pool actuel de mission_interests
  // (l'intérêt propre de l'Œil transférant a déjà été supprimé ci-dessus).
  await advanceCandidateCascade(db, io, emitToUser, mission, {});

  return { ok: true, transferType, deadline };
}

// Fermé pour l'Œil (2026-07-30, prompt 18) — défense en profondeur derrière le remplacement de
// l'ancien bouton "Signaler un empêchement" par "Demander assistance" côté frontend (session
// séparée, Dashboard.jsx/Missions.jsx, PROMPT_17/cb8a083) : grep exhaustif shoofly-react
// (missionsAPI.transfer) confirmé, plus aucun appelant. Même principe que la fermeture de
// /:id/refuse (e44af9f) et /:id/status{cancelled} (53d4cd0) : POST /:id/assistance (catégorie
// urgence) est désormais l'unique point d'entrée HTTP pour releaseMissionForReplacement
// (réutilisée telle quelle, voir plus bas) — mécanique de libération/cascade/cooldown/chaîne
// prorata strictement identique, seule la pénalité de fiabilité diffère (toujours supprimée
// depuis ce chemin, skipReliabilityPenalty systématique).
router.post('/:id/transfer', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  return res.status(403).json({ error: "Le transfert direct d'une mission assignée n'est plus disponible. Utilisez \"Demander assistance\" pour signaler un empêchement ou une urgence." });
}));

// ── POST /missions/:id/assistance ── "Demander assistance" — point d'entrée unique ──
// Remplace, pour l'Œil assigné à une mission en cours, le recours direct à /refuse, /transfer ou
// /status{cancelled}. Mise à jour 2026-07-28 (correctif URGENCE) : /:id/refuse est désormais
// fermé pour l'Œil (403, voir plus bas). Mise à jour 2026-07-30 (prompt 18) : /:id/transfer est
// à son tour fermé pour l'Œil (403, voir plus haut) — cette route est désormais le SEUL chemin
// HTTP restant, pour tout rôle, vers releaseMissionForReplacement ; /status{cancelled}
// (annulation sans remplacement) reste ouvert en parallèle, non concerné par ces fermetures.
// category='urgence' (accident, agression/vol/menace, hospitalisation, situation dangereuse) :
// aucune validation requise, recherche immédiate d'un remplaçant via releaseMissionForReplacement
// (même fonction qu'utilisait l'ancien /:id/transfer avant sa fermeture — transitionMission/
// cooldown/cascade identiques), avec pénalité de fiabilité SUPPRIMÉE via skipReliabilityPenalty :
// un Œil qui déclare une urgence réelle ne doit pas voir son score baisser — décision explicite,
// révisant le choix initial "non contourné" du rapport de la session précédente. Depuis la
// fermeture de /:id/transfer, ce flag est passé par le SEUL appelant restant de la fonction : la
// branche "pénalité conservée" (skipReliabilityPenalty falsy) est de fait devenue inatteignable
// depuis n'importe quelle route HTTP (constat, non traité ici — voir rapport de session prompt 18).
// Cooldown TOUJOURS posé (aucun bypass), y compris le cooldown 'before' (correctif 2026-07-30 :
// ancré sur scheduled_at, pas sur l'instant du clic) — voir le commentaire de
// releaseMissionForReplacement.
// category='mission' (client absent/injoignable, mauvaise adresse, mission différente de la
// description) : gèle la mission en sous_reclamation en attendant la réponse du client — voir
// POST /:id/assistance/respond.
router.post('/:id/assistance', authenticate, requireRole('oeil'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');
  const { category, reason } = req.body;

  if (!['urgence', 'mission'].includes(category)) {
    return res.status(400).json({ error: 'Catégorie invalide (attendu: urgence ou mission)' });
  }
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Le motif est obligatoire' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (!['assigned', 'en_route', 'active'].includes(mission.status)) {
    return res.status(400).json({ error: 'Assistance impossible pour ce statut de mission' });
  }

  const trimmedReason = reason.trim();

  if (category === 'urgence') {
    const result = await releaseMissionForReplacement(db, io, emitToUser, mission, req.user.id, `Assistance urgence : ${trimmedReason}`, {
      historyNoteVerb: "Assistance urgence déclenchée par l'Œil",
      clientAlertTitle: '🚨 Urgence signalée sur votre mission',
      clientAlertBody: `Votre Œil a signalé une urgence sur "${mission.title}". Nous recherchons immédiatement un remplaçant.`,
      clientAlertTitleKey: 'assistanceUrgenceClientTitle',
      clientAlertBodyKey: 'assistanceUrgenceClientBody',
      systemMessageText: "L'Œil a signalé une urgence. Recherche d'un remplaçant en cours.",
      systemMessageKey: 'assistanceUrgenceSystemMessage',
      skipReliabilityPenalty: true,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    const { rows: [assistanceRequest] } = await db.query(
      `INSERT INTO mission_assistance_requests (mission_id, oeil_id, category, reason, status, transfer_type, responded_at)
       VALUES ($1,$2,'urgence',$3,'triggered',$4,NOW()) RETURNING *`,
      [mission.id, req.user.id, trimmedReason, result.transferType]
    );

    return res.json({ ok: true, category: 'urgence', assistance_request_id: assistanceRequest.id, transfer_type: result.transferType, deadline: result.deadline });
  }

  // category === 'mission' — le client doit valider ou contester la déclaration de l'Œil.
  const clientValidationHours = await getSetting(db, 'client_validation_hours', 12);
  const expiresAt = new Date(Date.now() + clientValidationHours * 3600 * 1000);

  try {
    await transitionMission(db, mission.id, mission.status, 'sous_reclamation', req.user.id, {
      note: `Assistance mission déclarée par l'Œil : ${trimmedReason}`,
    });
  } catch (e) {
    if (e instanceof MissionTransitionError) return res.status(409).json({ error: e.message });
    throw e;
  }

  const { rows: [assistanceRequest] } = await db.query(
    `INSERT INTO mission_assistance_requests (mission_id, oeil_id, category, reason, status, expires_at)
     VALUES ($1,$2,'mission',$3,'pending',$4) RETURNING *`,
    [mission.id, req.user.id, trimmedReason, expiresAt]
  );

  await notify(db, mission.client_id,
    '🆘 Votre Œil signale un problème',
    `Votre Œil a signalé : "${trimmedReason}" sur la mission "${mission.title}". Merci de confirmer si vous validez sa déclaration (vous avez ${clientValidationHours}h).`,
    'mission', mission.id, emitToUser, 'mission_view', 'assistanceMissionRequestClientTitle', 'assistanceMissionRequestClientBody',
    { missionTitle: mission.title, reason: trimmedReason, hours: clientValidationHours }
  );

  await db.query(
    `INSERT INTO mission_messages (mission_id,sender_id,content,type,content_key,params) VALUES ($1,$2,$3,'system',$4,$5)`,
    [mission.id, req.user.id, `L'Œil signale : ${trimmedReason}. En attente de votre confirmation.`, 'assistanceMissionRequestSystemMessage', JSON.stringify({ reason: trimmedReason })]
  );

  if (io) {
    io.to(`mission:${mission.id}`).emit('mission_status_changed', { missionId: mission.id, status: 'sous_reclamation' });
    io.to('room:admin').emit('mission_updated', { id: mission.id, status: 'sous_reclamation' });
  }

  res.json({ ok: true, category: 'mission', assistance_request_id: assistanceRequest.id, expires_at: expiresAt });
}));

// ── POST /missions/:id/assistance/respond ── Le client valide ou conteste ──
// action='validate' : clôture la mission et paie l'Œil intégralement — réutilise directement
// walletService.credit + transitionMission (mêmes primitifs que PUT /admin/claims/:missionId/
// resolve, décision='oeil'), sans dupliquer de logique financière ni passer par une route admin.
// action='dispute' : transforme la déclaration en ticket litige classique (support_tickets,
// catégorie 'mission') ET en entrée `claims` — cette 2e écriture n'est PAS une duplication de
// mécanisme mais un branchement volontaire sur l'arbitrage financier déjà existant : elle rend
// le litige visible et résolvable tel quel via l'écran admin "Réclamations" existant (GET
// /admin/claims, PUT /admin/claims/:missionId/resolve) SANS AUCUNE modification de cette route —
// voir rapport de session pour la justification complète (mission_id UNIQUE sur claims vérifié
// non conflictuel : les deux issues de résolution ferment définitivement ou marquent
// validated_at, donc /:id/claim ne peut plus jamais réinsérer sur ce mission_id ensuite).
router.post('/:id/assistance/respond', authenticate, requireRole('client'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');
  const io = req.app.get('io');
  const { action, comment } = req.body;

  if (!['validate', 'dispute'].includes(action)) return res.status(400).json({ error: 'Action invalide (attendu: validate ou dispute)' });

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.client_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });

  const { rows: [assistanceRequest] } = await db.query(
    `SELECT * FROM mission_assistance_requests WHERE mission_id=$1 AND category='mission' AND status='pending' ORDER BY created_at DESC LIMIT 1`,
    [mission.id]
  );
  if (!assistanceRequest) return res.status(404).json({ error: "Aucune demande d'assistance en attente pour cette mission" });
  if (mission.status !== 'sous_reclamation') return res.status(409).json({ error: 'Cette demande a déjà été traitée' });

  if (action === 'validate') {
    // Rempli uniquement pour payment_method='cash' — voir POST /:id/validate ci-dessus pour la
    // même logique et sa justification détaillée.
    let cashSettlement = null;
    try {
      await walletService.withTransaction(db, async (client) => {
        if (mission.payment_method === 'payzone') {
          await walletService.credit(client, mission.oeil_id, 'oeil', mission.oeil_earning, 'Assistance mission validée par le client (paiement intégral)', mission.id);
        } else {
          cashSettlement = await settleCashCommission(client, mission, 'Commission Shoofly — mission cash (assistance validée par le client)');
        }
        await transitionMission(client, mission.id, 'sous_reclamation', 'completed', req.user.id, {
          extraFields: { validated_at: 'NOW()', is_priority: false },
          note: 'Assistance mission validée par le client',
        });
        await client.query(
          `UPDATE mission_assistance_requests SET status='validated', responded_at=NOW(), client_comment=$1 WHERE id=$2`,
          [comment?.trim() || null, assistanceRequest.id]
        );
      });
    } catch (e) {
      if (e instanceof MissionTransitionError) return res.status(409).json({ error: e.message });
      throw e;
    }

    if (cashSettlement) {
      await notify(db, mission.oeil_id, '✅ Confirmé', `Le client a validé votre déclaration d'assistance sur "${mission.title}". ${cashSettlement.collected} MAD de commission débités de votre wallet (mission cash).`, 'info', mission.id, emitToUser, null, 'commissionDebitedOeilTitle', 'commissionDebitedOeilBody', { missionTitle: mission.title, amount: cashSettlement.collected });
    } else {
      await notify(db, mission.oeil_id, '💰 Paiement reçu !', `Le client a validé votre déclaration d'assistance sur "${mission.title}". ${mission.oeil_earning} MAD crédités.`, 'info', mission.id, emitToUser, null, 'assistanceValidatedOeilTitle', 'assistanceValidatedOeilBody', { missionTitle: mission.title, amount: mission.oeil_earning });
    }
    await notify(db, mission.client_id, '✅ Confirmé', `Vous avez validé la déclaration de l'Œil pour "${mission.title}".`, 'info', mission.id, emitToUser, null, 'assistanceValidatedClientTitle', 'assistanceValidatedClientBody', { missionTitle: mission.title });

    if (io) {
      io.to('room:admin').emit('mission_updated', { id: mission.id, status: 'completed' });
      // Ce chemin transitionne sous_reclamation -> completed sans passer par POST /:id/status
      // (voir RAPPORT_DIAGNOSTIC_RAPPEL_CLIENT_ET_CHAT_MISSION.md §2.3) — fermeture de room
      // répliquée ici pour cette même raison.
      closeMissionChatRoom(io, mission.id);
    }

    return res.json({ ok: true, action: 'validated' });
  }

  // action === 'dispute'
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Un commentaire est requis pour contester' });
  const trimmedComment = comment.trim();

  const ticketId = uuidv4();
  const reference = await generateUniqueReference(db);
  const { rows: [ticket] } = await db.query(
    `INSERT INTO support_tickets (id, reference, user_id, user_role, category, subcategory, mission_id, initial_message, is_urgent, last_user_message_at)
     VALUES ($1,$2,$3,'client','mission',$4,$5,$6,false,NOW()) RETURNING *`,
    [ticketId, reference, req.user.id, assistanceRequest.reason, mission.id,
     `[Litige assistance mission] L'Œil a déclaré : "${assistanceRequest.reason}". Le client conteste : "${trimmedComment}"`]
  );
  await db.query(
    `INSERT INTO ticket_messages (ticket_id, sender_id, sender_role, content) VALUES ($1,$2,'client',$3)`,
    [ticket.id, req.user.id, trimmedComment]
  );
  await db.query(`UPDATE missions SET under_surveillance=true, updated_at=NOW() WHERE id=$1`, [mission.id]);

  // Entrée claims — branche ce litige sur l'arbitrage admin existant (PUT /admin/claims/
  // :missionId/resolve), déjà valable ici car cette route ne dépend que de
  // mission.status='sous_reclamation', pas de l'origine de la réclamation.
  await db.query(`INSERT INTO claims (mission_id, client_id, comment) VALUES ($1,$2,$3)`, [mission.id, req.user.id, trimmedComment]);

  await db.query(
    `UPDATE mission_assistance_requests SET status='disputed', responded_at=NOW(), client_comment=$1, support_ticket_id=$2 WHERE id=$3`,
    [trimmedComment, ticket.id, assistanceRequest.id]
  );

  const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin'`);
  for (const admin of admins) {
    await notify(db, admin.id, '🚨 Nouvelle réclamation', `Litige assistance sur la mission "${mission.title}" — contestée par le client.`, 'claim', mission.id, emitToUser, null, 'newClaimAdminTitle', 'newClaimAdminBody', { missionTitle: mission.title });
  }
  await notify(db, mission.oeil_id, 'Déclaration contestée', `Le client a contesté votre déclaration sur "${mission.title}". Un litige a été ouvert, un admin va trancher.`, 'info', mission.id, emitToUser, null, 'assistanceDisputedOeilTitle', 'assistanceDisputedOeilBody', { missionTitle: mission.title });

  if (io) io.to('room:admin').emit('mission_updated', { id: mission.id, under_surveillance: true });

  res.json({ ok: true, action: 'disputed', ticket_reference: ticket.reference });
}));

// ── POST /missions/assistance-requests/:id/requalify ── Admin requalifie une urgence a posteriori ──
// (PROMPT 1 point 5, 2026-08-17 — section 0/B4). Le chemin assistance/urgence reste et doit
// rester sans pénalité au moment où l'Œil le déclenche (releaseMissionForReplacement,
// skipReliabilityPenalty:true — une urgence ne se juge pas en temps réel, voir commentaire plus
// haut ~2005). Cette route est le SEUL moyen de faire coûter des points à une déclaration
// d'urgence, et seulement après coup, une fois qu'un admin — typiquement depuis l'historique de
// l'Œil — juge qu'elle n'était pas légitime (abus répété, déclaration mensongère, etc.).
// Catégorie 'urgence' uniquement : la catégorie 'mission' (client absent/injoignable...) est déjà
// arbitrée par un humain via PUT /admin/claims/:missionId/resolve avant toute conséquence, elle
// n'a pas ce besoin. requireRole('admin') générique (pas requireSuperAdmin) : même gate que les
// autres actions admin touchant reliability_score (voir routes/reliabilityRoutes.js).
router.post('/assistance-requests/:id/requalify', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const emitToUser = req.app.get('emitToUser');

  const { rows: [assistanceRequest] } = await db.query('SELECT * FROM mission_assistance_requests WHERE id=$1', [req.params.id]);
  if (!assistanceRequest) return res.status(404).json({ error: 'Déclaration d\'assistance introuvable' });
  if (assistanceRequest.category !== 'urgence') {
    return res.status(400).json({ error: 'Seules les déclarations "urgence" peuvent être requalifiées — la catégorie "mission" est déjà arbitrée via le litige client.' });
  }
  if (assistanceRequest.admin_requalified_at) {
    return res.status(400).json({ error: 'Cette déclaration a déjà été requalifiée' });
  }

  const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [assistanceRequest.mission_id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  // Garde d'idempotence posée sur l'UPDATE lui-même, même principe que les autres routes de ce
  // chantier : si deux admins requalifient la même déclaration en concurrence, un seul applique
  // réellement la pénalité.
  const { rowCount } = await db.query(
    `UPDATE mission_assistance_requests SET admin_requalified_at=NOW(), admin_requalified_by=$1
     WHERE id=$2 AND admin_requalified_at IS NULL`,
    [req.user.id, assistanceRequest.id]
  );
  if (rowCount === 0) return res.status(409).json({ error: 'Cette déclaration a été requalifiée entre-temps' });

  // Préavis pénalisé = celui réellement donné par l'Œil au moment de sa déclaration (created_at
  // de cette ligne), jamais l'instant de la requalification elle-même (souvent bien après
  // mission.scheduled_at, ce qui donnerait systématiquement un préavis négatif absurde).
  const { points, reason, isGrave } = await computeLatePenalty(
    db, mission.scheduled_at, 'libération urgence requalifiée non légitime', assistanceRequest.created_at
  );
  // points===0 (palier 1 désactivé, préavis suffisant) : ne journalise PAS un événement de
  // fiabilité "0 pt" — la requalification elle-même reste tracée ci-dessus
  // (admin_requalified_at/by), mais un 0 inséré dans reliability_events se moyennerait quand même
  // dans computeReliabilityScore et tirerait le score vers le bas par simple dilution du
  // dénominateur, alors que "réexaminé et blanchi" doit rester strictement neutre — jamais pire
  // que ne pas avoir d'avis du tout.
  if (points !== 0) {
    await logReliabilityEvent(db, assistanceRequest.oeil_id, mission.id, points, reason, isGrave);
  }

  await notify(db, assistanceRequest.oeil_id, 'Déclaration d\'urgence requalifiée',
    `Un administrateur a examiné votre déclaration d'urgence sur la mission "${mission.title}" et l'a jugée non légitime.`,
    'mission', mission.id, emitToUser);

  res.json({
    assistance_request: { ...assistanceRequest, admin_requalified_at: new Date(), admin_requalified_by: req.user.id },
    penalty: { points, reason },
  });
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

// ── GET /:id/assignable-oeils ── Picker admin (assign-admin) : champs bruts ──
// Route dédiée plutôt qu'un paramètre ajouté à GET /users/oeils : cette dernière est aussi
// consommée par des écrans client (client/Oeils.jsx, client/Dashboard.jsx) avec le filtre
// `p.is_verified=true` toujours actif — pas question d'y brancher un mode qui expose
// is_active/is_suspended/suspended_reason, même derrière un paramètre. Réservée à l'admin
// (requireRole) et ne filtre ni ne masque aucun Œil, contrairement à /users/oeils : c'est
// justement le but (badges d'éligibilité sur des candidats par ailleurs inéligibles). Voir
// RAPPORT_GAP_BACKEND_MASQUAGE_ADMIN_OVERRIDE.md section 5, point 2.
router.get('/:id/assignable-oeils', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: [mission] } = await db.query('SELECT id, scheduled_at FROM missions WHERE id=$1', [req.params.id]);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  const { rows } = await db.query(`
    SELECT u.id, u.first_name, u.last_name, u.city, u.avatar_url,
           u.is_active, u.is_suspended, u.suspended_reason,
           p.bio, p.coverage_zone, p.is_verified, p.is_available,
           p.rating_avg, p.rating_count, p.total_missions
    FROM users u JOIN oeil_profiles p ON p.user_id=u.id
    WHERE u.role='oeil'
    ORDER BY p.rating_avg DESC, p.total_missions DESC
  `);

  // Conflit de créneau en une seule requête groupée (getScheduleConflictSetBulk) plutôt
  // qu'une vérification par candidat — même esprit que computeAvgResponseMinutesBulk.
  const conflictSet = await getScheduleConflictSetBulk(db, rows.map(o => o.id), {
    scheduledAt: mission.scheduled_at,
    excludeMissionId: mission.id,
  });

  const oeils = rows.map(o => ({ ...o, has_schedule_conflict: conflictSet.has(o.id) }));
  res.json({ oeils });
}));

// ── POST /missions/:id/assign-admin ── Admin affecte manuellement ──
router.post('/:id/assign-admin', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
    const db = getDb();
    const emitToUser = req.app.get('emitToUser');
    const io = req.app.get('io');
    const { oeil_id, override_warning, override_reason } = req.body;
    if (!oeil_id) return res.status(400).json({ error: 'oeil_id requis' });
    const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
    if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
    if (!['pending'].includes(mission.status)) return res.status(400).json({ error: 'Mission non disponible pour affectation' });
    // Capturé avant l'écrasement des champs de cascade plus bas (transitionMission + nettoyage
    // mission_interests) — reflète l'état au moment de l'appel, jamais bloquant (décision produit :
    // l'admin doit toujours pouvoir écraser une cascade en cours).
    const cascadeInterrupted = isBatchLive(mission);

    // Contrôle faisant foi — is_verified/is_available/conflit de créneau TOUJOURS bloquants ;
    // is_suspended/is_active (anti-fraude) volontairement passés en overridable:true ici pour ne
    // pas encore rejeter à ce stade (le rejet définitif sur ces deux-là, s'il a lieu, est décidé
    // juste après par le bloc de confirmation ci-dessous — priorité aux contrôles objectifs,
    // jamais overridables, avant de solliciter une confirmation sur un contrôle subjectif).
    // 2026-07-27, Partie F : couvre désormais aussi is_verified et is_available (jamais
    // vérifiés ici avant ce correctif malgré leur sélection) et is_active (jamais vérifié du
    // tout ici avant ce correctif).
    const assignCheck = await checkOeilAssignable(db, oeil_id, {
      scheduledAt: mission.scheduled_at,
      excludeMissionId: mission.id,
      overridable: true,
    });
    if (assignCheck.error) return res.status(400).json({ error: assignCheck.error });

    // Mission cash (2026-08-13) : solde wallet requis pour couvrir la commission — TOUJOURS
    // bloquant, contrairement à la suspension/l'anti-fraude/le cooldown ci-dessous, jamais
    // overridable par l'admin (règle métier explicite : le mécanisme de commission prépayée
    // n'a pas de dérogation). N'exécute rien pour 'payzone'.
    if (mission.payment_method === 'cash') {
      const cashBalanceCheck = await checkCashCommissionBalance(db, oeil_id, mission.commission);
      if (cashBalanceCheck.error) return res.status(400).json({ error: cashBalanceCheck.error });
    }

    // Suspension / blocage anti-fraude / cooldown de transfert : bloqué par défaut, mais l'admin
    // peut passer outre avec confirmation explicite (override_warning, mécanisme préexistant —
    // is_active y rejoint is_suspended depuis 2026-07-27, Partie F : même sémantique, un jugement
    // sur le comportement passé de l'Œil que l'admin peut vouloir outrepasser pour une mission
    // urgente sans autre candidat, à condition d'être informé et de confirmer explicitement).
    const { rows: [cooldownRow] } = await db.query('SELECT transfer_cooldown_until FROM users WHERE id=$1', [oeil_id]);
    const hasCooldown = cooldownRow?.transfer_cooldown_until && new Date(cooldownRow.transfer_cooldown_until) > new Date();
    if ((assignCheck.isSuspended || !assignCheck.isActive || hasCooldown) && !override_warning) {
      const reasons = [];
      if (assignCheck.isSuspended) reasons.push('cet Œil est actuellement suspendu');
      if (!assignCheck.isActive) reasons.push('cet Œil est bloqué pour anti-fraude');
      if (hasCooldown) {
        const remaining = Math.ceil((new Date(cooldownRow.transfer_cooldown_until) - Date.now()) / 3600000);
        reasons.push(`cet Œil est en cooldown pour encore ${remaining}h suite à un transfert de mission`);
      }
      return res.status(409).json({
        error: `Attention : ${reasons.join(' et ')}. Confirmez pour affecter quand même.`,
        requires_confirmation: true,
      });
    }

  const { rows: [oeil] } = await db.query('SELECT first_name, last_name, phone FROM users WHERE id=$1', [oeil_id]);

  // Trace de l'override — si l'admin a dû passer outre suspension/anti-fraude/cooldown, consigné
  // dans mission_status_history.note (même mécanisme que toute transition, voir transitionMission
  // ci-dessous) avec la raison libre optionnelle fournie (même pattern que le champ `reason` de
  // toggle-active, commit c1805a3).
  let note = 'Affectation manuelle par admin';
  if (assignCheck.isSuspended || !assignCheck.isActive || hasCooldown) {
    const overrideReasons = [];
    if (assignCheck.isSuspended) overrideReasons.push('suspendu');
    if (!assignCheck.isActive) overrideReasons.push('bloqué anti-fraude');
    if (hasCooldown) overrideReasons.push('cooldown de transfert');
    note = `Affectation manuelle par admin (override : ${overrideReasons.join(', ')})`;
    if (override_reason) note += ` — raison : ${override_reason}`;
  }

  try {
    await transitionMission(db, mission.id, 'pending', 'assigned', req.user.id, {
      extraFields: {
        oeil_id, assigned_at: 'NOW()', is_priority: false, transfer_deadline: null,
        presence_confirmed_at: null, presence_confirmation_requested_at: null, presence_confirmation_deadline_at: null,
        candidate_window_ends_at: null, pending_candidate_id: null, batch_tiebreak_ends_at: null,
        urgent_whatsapp_next_wave_at: null,
      },
      note,
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

  // Mission issue d'un transfert en cours de route : on ouvre une nouvelle ligne dans la chaîne
  // pour ce nouvel Œil (elle sera fermée à son tour s'il retransfère, ou au moment de la validation finale).
  if (mission.transfer_type === 'during') {
    const { rows: [{ n: nextOrder }] } = await db.query(
      `SELECT COALESCE(MAX(sequence_order), 0) + 1 AS n FROM mission_transfer_chain WHERE mission_id=$1`,
      [mission.id]
    );
    await db.query(
      `INSERT INTO mission_transfer_chain (mission_id, oeil_id, started_at, sequence_order)
       VALUES ($1, $2, NOW(), $3)`,
      [mission.id, oeil_id, nextOrder]
    );
  }

  await notify(db, oeil_id,
    '📋 Mission assignée par admin',
    `L'admin vous a assigné la mission "${mission.title}". Vérifiez les détails.`,
    'mission', mission.id, emitToUser, null, 'missionAssignedByAdminTitle', 'missionAssignedByAdminBody', {missionTitle: mission.title}
  );
  if (oeil.phone) {
    await sendWhatsAppTemplate(waselTemplates.mission_assigned_by_admin_oeil.template_name, oeil.phone, [mission.title]);
  }
  await notify(db, mission.client_id,
    '✅ Œil trouvé',
    `Un Œil a été assigné à votre mission "${mission.title}".`,
    'mission', mission.id, emitToUser, null, 'oeilFoundClientTitle', 'oeilFoundClientBody', {missionTitle: mission.title}
  );
  const { rows: [clientContactAssign] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.client_id]);
  if (clientContactAssign?.phone) {
    const oeilNameAssign = `${oeil.first_name} ${oeil.last_name}`;
    await sendWhatsAppTemplate(waselTemplates.oeil_assigned_client.template_name, clientContactAssign.phone, [oeilNameAssign, mission.title]);
  }

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
async function checkTransferDeadlines(db, io, emitToUser) {
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

    // Ce chemin transitionne vers 'cancelled' sans passer par POST /:id/status (voir
    // RAPPORT_DIAGNOSTIC_RAPPEL_CLIENT_ET_CHAT_MISSION.md §2.3) — fermeture de room répliquée
    // ici pour cette même raison.
    closeMissionChatRoom(io, mission.id);

    // Pénalité aggravée sur l'Œil 1 si pendant mission — la pénalité (financière + fiabilité)
    // est sautée quand la libération d'origine est marquée transfer_no_penalty (URGENCE,
    // suspension admin, confirmation de présence non reçue — voir les 3 sites qui posent ce flag
    // et RAPPORT_CORRECTIF_PENALITE_DIFFEREE.md). Le cooldown et transfer_no_replacement_count
    // restent posés SANS EXCEPTION dans tous les cas (même principe que le cooldown de
    // releaseMissionForReplacement, 2026-07-30 : une indisponibilité réelle rend l'Œil
    // temporairement indisponible pour de nouvelles missions, urgence authentique ou non — seule
    // la pénalité financière/fiabilité est conditionnée par transfer_no_penalty).
if (mission.transfer_type === 'during' && mission.transferred_from) {
        if (!mission.transfer_no_penalty) {
          const transferDuringNoReplacementDebitCapMad = await getSetting(db, 'transfer_during_no_replacement_debit_cap_mad', 100);
          const transferDuringNoReplacementPenaltyPoints = await getSetting(db, 'transfer_during_no_replacement_penalty_points', -70);
          // Débit plafonné au solde réel (voir même pattern commenté en détail dans le cron H+30,
          // index.js) : lockBalance + debit() dans la même transaction pour que le montant journalisé
          // ne dépasse jamais ce qui a réellement été déduit.
          const deducted = await walletService.withTransaction(db, async (client) => {
            const currentBalance = await walletService.lockBalance(client, mission.transferred_from, 'oeil');
            const deducted = Math.min(transferDuringNoReplacementDebitCapMad, currentBalance || 0);
            if (deducted > 0) {
              await walletService.debit(client, mission.transferred_from, 'oeil', deducted, 'Pénalité — aucun remplaçant trouvé', mission.id);
            }
            return deducted;
          });
          await logReliabilityEvent(db, mission.transferred_from, mission.id, transferDuringNoReplacementPenaltyPoints, 'Transfert pendant mission sans remplaçant trouvé — abandon en cours de mission', true);

          // Persisté (pas seulement émis en direct) : même pattern que la pénalité H+30 (index.js)
          // via notify(), sinon un Œil hors-ligne au moment précis du tick perd cette notification
          // pour toujours (RAPPORT_TEXTES_DYNAMIQUES_HARDCODES.md §7).
          await notify(db, mission.transferred_from, '⚠️ Pénalité appliquée',
            `Aucun remplaçant n'a été trouvé pour "${mission.title}". -${deducted} MAD déduits.`,
            'error', mission.id, emitToUser, 'reliability_page', 'penaltyAppliedTitle', 'penaltyAppliedNoReplacementBody',
            { missionTitle: mission.title, amount: deducted });
        }
        const abandonCooldownHours = await getSetting(db, 'abandon_during_mission_cooldown_hours', 48);
        await db.query(`
          UPDATE users SET
            transfer_no_replacement_count=transfer_no_replacement_count+1,
            transfer_cooldown_until=NOW() + INTERVAL '1 hour' * $2::numeric
          WHERE id=$1
        `, [mission.transferred_from, abandonCooldownHours]);
       } else if (mission.transfer_type === 'before' && mission.transferred_from && !mission.transfer_no_penalty) {
      const transferBeforeNoReplacementPenaltyPoints = await getSetting(db, 'transfer_before_no_replacement_penalty_points', -10);
      await logReliabilityEvent(db, mission.transferred_from, mission.id, transferBeforeNoReplacementPenaltyPoints, 'Transfert avant démarrage sans remplaçant trouvé', true);

    }

// Remboursement client — annulation par le système (aucun remplaçant trouvé), non imputable au client : intégral
      // Mission cash (2026-08-13) : refundOnCancellation n'est appelée QUE pour 'payzone' —
      // Shoofly n'a jamais encaissé le client d'une mission cash. refund.js n'est jamais
      // modifié ; seul ce point d'appel est conditionné (garde-fou explicite de la session).
      const refund = mission.payment_method === 'payzone'
        ? await refundOnCancellation(db, mission, false, 'Remboursement — aucun Œil disponible')
        : 0;
      const cancelBody = mission.payment_method === 'cash'
        ? `Aucun Œil disponible pour "${mission.title}".`
        : `Aucun Œil disponible pour "${mission.title}". Remboursement intégral effectué.`;

    await emitToUser?.(mission.client_id, 'notification', {
      title: '❌ Mission annulée',
      body: cancelBody,
      type: 'error'
    });

    await db.query(
      `INSERT INTO notifications (user_id,title,body,type,mission_id,action_type,title_key,body_key,params) VALUES ($1,'❌ Mission annulée',$2,'error',$3,'mission_view',$4,$5,$6)`,
      [mission.client_id, cancelBody, mission.id, 'missionCancelledNoReplacementTitle', 'missionCancelledNoReplacementBody', null]
    );

    // Gabarit WhatsApp approuvé pour cette notification affirme explicitement un montant
    // remboursé ({{2}}, voir config/waselTemplates.js) — texte figé côté Wasel/Meta, pas
    // réécrivable ici. Aucun remboursement n'existant pour une mission cash, l'envoyer
    // reviendrait à affirmer au client un remboursement qui n'a pas eu lieu : sauté pour
    // 'cash' plutôt qu'envoyé avec un montant trompeur (0 MAD). Nécessiterait un gabarit dédié
    // approuvé séparément si ce message doit un jour exister pour le cash — hors périmètre de
    // cette session (voir rapport).
    if (mission.payment_method === 'payzone') {
      const { rows: [clientContactNoReplacement] } = await db.query('SELECT phone FROM users WHERE id=$1', [mission.client_id]);
      if (clientContactNoReplacement?.phone) {
        await sendWhatsAppTemplate(waselTemplates.mission_cancelled_no_replacement_client.template_name, clientContactNoReplacement.phone, [mission.title, `${refund} MAD`]);
      }
    }
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

  // Un seul SELECT admins par tick, réutilisé pour chaque mission ci-dessous (voir alerte admin
  // plus bas) — la liste ne change pas en cours de tick (audit perf 2026-07-26).
  const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);

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
          transfer_no_penalty: true,
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

  // Vérifier suspension et cooldown de transfert — sur l'Œil qu'on embauche, pas sur le client.
  // Cooldown de transfert hors périmètre des 5 vérifications standard de checkOeilAssignable
  // (spec réattribution 2026-07-27, Partie F) — conservé tel quel, aucun override côté client.
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

  // is_verified/is_available/is_active (anti-fraude)/conflit de créneau — jamais d'override
  // côté client (2026-07-27, Partie F : is_suspended déjà écarté ci-dessus, ce contrôle couvre
  // en plus is_active, qui n'était vérifié nulle part sur ce chemin avant ce correctif).
  const assignCheck = await checkOeilAssignable(db, oeilId, {
    scheduledAt: mission.scheduled_at,
    excludeMissionId: mission.id,
  });
  if (assignCheck.error) {
    const status = assignCheck.code === 'suspended_or_blocked' ? 403 : 400;
    return { ok: false, status, error: assignCheck.error };
  }

  // Mission cash (2026-08-13) : en plus de checkOeilAssignable ci-dessus, vérifie que le wallet
  // de l'Œil couvre la commission de cette mission — appelant partagé par POST /:id/hire/:oeilId
  // (client choisit un candidat) et la résolution automatique de départage de la cascade par lot
  // (index.js) : les deux profitent de ce contrôle sans duplication. Retour {ok:false} déjà géré
  // par les deux appelants exactement comme un échec de checkOeilAssignable (index.js retente au
  // prochain tick, POST /:id/hire/:oeilId renvoie l'erreur telle quelle). N'exécute rien pour
  // 'payzone'.
  if (mission.payment_method === 'cash') {
    const balanceCheck = await checkCashCommissionBalance(db, oeilId, mission.commission);
    if (balanceCheck.error) {
      return { ok: false, status: 400, error: balanceCheck.error };
    }
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
        urgent_whatsapp_next_wave_at: null,
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

  // Supprimer les intérêts en conflit de créneau — requête distincte du contrôle de
  // checkOeilAssignable ci-dessus (ici : les AUTRES missions encore pending sur lesquelles cet
  // Œil avait candidaté, pas ses missions déjà assignées) ; nécessite donc sa propre lecture du
  // réglage (scheduleConflictWindowHours n'est plus dans le scope de cette fonction depuis
  // l'extraction vers checkOeilAssignable, 2026-07-27 Partie F — getSetting est cache 60s,
  // ce second appel ne coûte pas de requête DB supplémentaire dans l'immense majorité des cas).
  const scheduleConflictWindowHours = await getSetting(db, 'schedule_conflict_window_hours', 4);
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

  // WhatsApp sur le numéro personnel de l'Œil embauché — {{1}} nom du client qui l'a choisi.
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
    // Téléphones résolus en un seul aller-retour (au lieu d'un SELECT par candidat, jusqu'à
    // candidate_batch_size — audit perf 2026-07-26) : la liste ne bouge pas pendant la boucle.
    const { rows: candidateContacts } = await db.query(
      'SELECT id, phone FROM users WHERE id = ANY($1::text[])', [candidateIds]
    );
    const phoneById = new Map(candidateContacts.map(c => [c.id, c.phone]));
    for (const nextOeilId of candidateIds) {
      await notify(db, nextOeilId,
        '🎯 Confirmez votre disponibilité',
        `Vous êtes parmi les candidats les mieux classés pour "${mission.title}". Confirmez votre disponibilité sous ${confirmationMinutes} min pour être considéré.`,
        'mission', mission.id, emitToUser, 'mission_view', 'candidateConfirmRequestTitle', 'candidateConfirmRequestBody',
        { missionTitle: mission.title, minutes: confirmationMinutes }
      );

      const candidatePhone = phoneById.get(nextOeilId);
      if (candidatePhone) {
        await sendWhatsAppTemplate(waselTemplates.candidate_confirmation_request.template_name, candidatePhone, [mission.title, String(confirmationMinutes)]);
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
    // Pas de WhatsApp ici — pas d'action rapide attendue du client (transparence seulement,
    // il n'est jamais sollicité pour un choix), voir filtrage WhatsApp 2026-07-25.

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
// client différent ("l'Œil n'a pas répondu à temps" plutôt que "a refusé"). io ajouté en
// paramètre (comme checkPresenceConfirmationDeadlines) pour pouvoir relayer advanceCandidateCascade
// — RAPPORT_DIAGNOSTIC_REFUS_EDIT_REQUEST.md, même correctif que la route de refus manuel ci-dessus.
async function checkMissionEditRequestExpiry(db, io, emitToUser) {
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

    // Délai de grâce avant filet de sécurité (checkTransferDeadlines) — même réglages que
    // POST /edit-requests/:id/reject ci-dessus.
    const graceMinutesQueue = await getSetting(db, 'transfer_grace_minutes_queue', 45);
    const graceMinutesOther = await getSetting(db, 'transfer_grace_minutes_other', 60);
    const graceMinutes = mission.type === 'file_attente' ? graceMinutesQueue : graceMinutesOther;
    const deadline = new Date(Date.now() + graceMinutes * 60 * 1000);

    let updatedMission;
    try {
      updatedMission = await transitionMission(db, mission.id, 'assigned', 'pending', null, {
        extraFields: { oeil_id: null, is_priority: true, transfer_deadline: deadline },
        note: 'Demande de modification expirée (délai dépassé sans réponse de l\'Œil)',
      });
    } catch (e) {
      if (e instanceof MissionTransitionError) {
        console.log(`ℹ️ checkMissionEditRequestExpiry: mission ${mission.id} ignorée, statut déjà changé entre-temps`);
        continue;
      }
      throw e;
    }

    // Même correctif que POST /edit-requests/:id/reject : retire la candidature de l'Œil sur
    // sa propre mission avant de rouvrir la cascade (sinon le cron de sélection pourrait le
    // réassigner à la mission qu'il vient de laisser expirer).
    await db.query(`DELETE FROM mission_interests WHERE mission_id=$1 AND oeil_id=$2`, [mission.id, mission.oeil_id]);

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

    // Relance la cascade — transfer_type/transferred_from volontairement NULL, même
    // justification que POST /edit-requests/:id/reject (éviter la pénalité -10 de
    // checkTransferDeadlines pour une non-réponse qui n'est ni une annulation ni un abandon).
    await advanceCandidateCascade(db, io, emitToUser, updatedMission, {});
  }
}

// ── Cron : expirer les demandes d'assistance MISSION sans réponse du client ──
// (appelé depuis index.js via cron). Même principe que autoValidateMissions.js
// (client_validation_hours réutilisé tel quel, même philosophie "silence du client = acceptation")
// plutôt qu'un nouveau réglage dédié — voir rapport de session pour la justification.
async function checkAssistanceRequestExpiry(db, io, emitToUser) {
  const { rows: expired } = await db.query(`
    SELECT * FROM mission_assistance_requests WHERE category='mission' AND status='pending' AND expires_at <= NOW()
  `);

  for (const ar of expired) {
    const { rows: [mission] } = await db.query('SELECT * FROM missions WHERE id=$1', [ar.mission_id]);

    // La mission a pu quitter sous_reclamation par une autre voie (ex: admin résolvant
    // directement via PUT /admin/claims/:missionId/resolve, valable dès que
    // status='sous_reclamation' peu importe l'origine — voir rapport). On aligne alors le statut
    // de la demande sur l'issue réelle plutôt que de la laisser 'pending' indéfiniment.
    if (!mission || mission.status !== 'sous_reclamation') {
      const resolvedStatus = mission?.status === 'completed' ? 'validated' : 'disputed';
      await db.query(
        `UPDATE mission_assistance_requests SET status=$1, responded_at=NOW() WHERE id=$2 AND status='pending'`,
        [resolvedStatus, ar.id]
      );
      continue;
    }

    // Rempli uniquement pour payment_method='cash' — voir POST /:id/validate pour la même
    // logique et sa justification détaillée.
    let cashSettlement = null;
    try {
      await walletService.withTransaction(db, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE mission_assistance_requests SET status='auto_validated', responded_at=NOW() WHERE id=$1 AND status='pending'`,
          [ar.id]
        );
        if (rowCount === 0) return; // déjà traitée entre-temps (réponse client juste avant ce tick)

        if (mission.payment_method === 'payzone') {
          await walletService.credit(client, mission.oeil_id, 'oeil', mission.oeil_earning, 'Assistance mission validée automatiquement (délai client dépassé)', mission.id);
        } else {
          cashSettlement = await settleCashCommission(client, mission, 'Commission Shoofly — mission cash (assistance auto-validée après délai)');
        }
        await transitionMission(client, mission.id, 'sous_reclamation', 'completed', null, {
          extraFields: { validated_at: 'NOW()', is_priority: false },
          note: 'Assistance mission auto-validée après délai sans réponse du client',
        });
      });
    } catch (e) {
      if (e instanceof MissionTransitionError) {
        console.log(`ℹ️ checkAssistanceRequestExpiry: mission ${ar.mission_id} ignorée, statut déjà changé entre-temps`);
        continue;
      }
      throw e;
    }

    if (cashSettlement) {
      await notify(db, mission.oeil_id, 'Mission clôturée automatiquement', `Délai écoulé sans réponse du client — "${mission.title}" clôturée, ${cashSettlement.collected} MAD de commission débités de votre wallet (mission cash).`, 'info', mission.id, emitToUser, null, 'commissionDebitedOeilTitle', 'commissionDebitedOeilBody', { missionTitle: mission.title, amount: cashSettlement.collected });
    } else {
      await notify(db, mission.oeil_id, '💰 Paiement reçu !', `Délai écoulé sans réponse du client — "${mission.title}" clôturée, ${mission.oeil_earning} MAD crédités.`, 'info', mission.id, emitToUser, null, 'assistanceAutoValidatedOeilTitle', 'assistanceAutoValidatedOeilBody', { missionTitle: mission.title, amount: mission.oeil_earning });
    }
    await notify(db, mission.client_id, 'Mission clôturée automatiquement', `Vous n'avez pas répondu à temps concernant "${mission.title}" — la déclaration de l'Œil a été considérée comme acceptée.`, 'info', mission.id, emitToUser, null, 'assistanceAutoValidatedClientTitle', 'assistanceAutoValidatedClientBody', { missionTitle: mission.title });

    // Ce chemin transitionne sous_reclamation -> completed sans passer par POST /:id/status
    // (voir RAPPORT_DIAGNOSTIC_RAPPEL_CLIENT_ET_CHAT_MISSION.md §2.3) — fermeture de room
    // répliquée ici pour cette même raison. Après le commit, même règle que les notify()
    // ci-dessus.
    closeMissionChatRoom(io, mission.id);
  }
}

router.checkTransferDeadlines = checkTransferDeadlines;
router.checkMissionEditRequestExpiry = checkMissionEditRequestExpiry;
router.checkAssistanceRequestExpiry = checkAssistanceRequestExpiry;
router.checkPresenceConfirmationDeadlines = checkPresenceConfirmationDeadlines;
router.hireOeilCore = hireOeilCore;
router.applyMissionEditChanges = applyMissionEditChanges;
router.advanceCandidateCascade = advanceCandidateCascade;
router.notify = notify;
router.closeMissionChatRoom = closeMissionChatRoom;
router.chatAccessExpiresAt = chatAccessExpiresAt;
router.pricing = pricing;
router.prepareMissionInsert = prepareMissionInsert;
router.insertMissionRecord = insertMissionRecord;
router.notifyNewMission = notifyNewMission;
router.sendUrgentWhatsAppWave = sendUrgentWhatsAppWave;
router.missionCreateValidators = missionCreateValidators;
router.missionCreateLimiter = missionCreateLimiter;
router.detectSensitiveContent = detectSensitiveContent;
module.exports = router;
