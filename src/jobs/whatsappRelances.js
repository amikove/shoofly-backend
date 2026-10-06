const { getSetting } = require('../utils/settings');
const wasel = require('../services/wasel');
const waselTemplates = require('../config/waselTemplates');
const { countVisibleForMissionId } = require('../utils/candidates');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Chantier 2 lot 1 bis (décisions BOSS du 2026-09-27) — WhatsApp en RELANCE seulement.
//
// La notification in-app + push part toujours tout de suite (inchangé). Le WhatsApp n'est plus
// qu'un filet : une ligne whatsapp_relances est programmée au moment de la notification, et ce
// job (cron chaque minute, index.js) ne l'envoie à échéance QUE si l'utilisateur n'a toujours pas
// réagi. Deux familles :
//   A. Présence Œil (J-1, H-2, H-45) — délai presence_whatsapp_relance_{j1,h2,h45}_minutes après
//      la demande. Envoi seulement si, à l'échéance : mission toujours 'assigned', au MÊME Œil,
//      MÊME ouverture du point de contrôle (presence_confirmation_requested_at inchangé), présence
//      toujours non confirmée, délai de réponse pas encore expiré.
//   B. Client « des Œils ont postulé » — délai candidature_whatsapp_relance_minutes après la
//      notification de seuil. Envoi seulement si, à l'échéance : mission toujours 'pending', la
//      notification n'est pas lue (is_read, quel que soit le canal) ET le client n'a pas ouvert la
//      liste des candidats depuis l'envoi (missions.client_interests_viewed_at, posé par GET
//      /missions/:id/interests quand le client lui-même l'appelle — seul appelant : InterestsModal).
//
// Sûr à plusieurs processus (même méthode que SC-6, chantier 1) :
//   - programmation : UNIQUE (mission_id, kind, user_id) + ON CONFLICT DO NOTHING → une relance par
//     étape, par mission et par destinataire (un Œil remplaçant a la sienne) ;
//   - envoi : UN SEUL UPDATE décide ET réserve la ligne (garde decided_at IS NULL). Deux processus
//     qui tiquent ensemble : un seul obtient la ligne (rowCount 1), l'autre passe. La décision lit
//     l'état de la mission dans CE MÊME ordre SQL — pas d'instantané JS entre le contrôle et la
//     réservation. Limite assumée : une confirmation/lecture qui arrive APRÈS cet UPDATE (pendant
//     l'appel Wasel, quelques centaines de ms) n'empêche plus l'envoi.
//   - une ligne réservée ('sending') puis interrompue (crash pendant l'envoi) n'est jamais
//     renvoyée : mieux vaut un WhatsApp manqué qu'un doublon (même compromis que les rappels).
// La raison de chaque décision reste sur la ligne (outcome) : tableau de bord admin
// « Notifications » (routes/users.js, GET /admin/dashboard/notifications).
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PRESENCE_KINDS = {
  presence_j1:  { setting: 'presence_whatsapp_relance_j1_minutes',  fallback: 60, template: 'presence_confirmation_request_j1' },
  presence_h2:  { setting: 'presence_whatsapp_relance_h2_minutes',  fallback: 20, template: 'presence_confirmation_request_sameday' },
  presence_h45: { setting: 'presence_whatsapp_relance_h45_minutes', fallback: 10, template: 'presence_confirmation_request_h45' },
};
const CLIENT_KIND = 'client_oeil_applied';
const BATCH = 100;

// Programme la relance WhatsApp d'une demande de confirmation de présence qui vient d'être
// ouverte (notification déjà envoyée). request_at et due_at sont lus/calculés EN SQL depuis la
// ligne missions (jamais via un Date JS : la comparaison d'égalité de l'envoi se fait à la
// microseconde). Ne lève jamais — la relance est un filet, jamais bloquante pour le cron.
async function schedulePresenceRelance(db, kind, missionId, oeilId, notificationId = null) {
  const cfg = PRESENCE_KINDS[kind];
  if (!cfg) throw new Error(`kind de relance inconnu : ${kind}`);
  try {
    const delay = await getSetting(db, cfg.setting, cfg.fallback);
    await db.query(
      `INSERT INTO whatsapp_relances (kind, mission_id, user_id, notification_id, request_at, due_at)
       SELECT $1, m.id, m.oeil_id, $4, m.presence_confirmation_requested_at,
              m.presence_confirmation_requested_at + INTERVAL '1 minute' * $5::numeric
       FROM missions m
       WHERE m.id = $2 AND m.oeil_id = $3 AND m.presence_confirmation_requested_at IS NOT NULL
       ON CONFLICT (mission_id, kind, user_id) DO NOTHING`,
      [kind, missionId, oeilId, notificationId, delay]
    );
  } catch (e) {
    console.error(`❌ Programmation relance WhatsApp ${kind} — mission ${missionId} :`, e.message);
  }
}

// Programme la relance WhatsApp « des Œils ont postulé » (notification de seuil déjà envoyée).
async function scheduleClientAppliedRelance(db, missionId, clientId, notificationId = null) {
  try {
    const delay = await getSetting(db, 'candidature_whatsapp_relance_minutes', 30);
    await db.query(
      `INSERT INTO whatsapp_relances (kind, mission_id, user_id, notification_id, due_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 minute' * $5::numeric)
       ON CONFLICT (mission_id, kind, user_id) DO NOTHING`,
      [CLIENT_KIND, missionId, clientId, notificationId, delay]
    );
  } catch (e) {
    console.error(`❌ Programmation relance WhatsApp candidatures — mission ${missionId} :`, e.message);
  }
}

// Décision + réservation atomiques (voir en-tête). Renvoie null si un autre processus a déjà pris
// la ligne. L'ordre des WHEN compte : « obsolète » (Œil changé / point de contrôle rouvert) passe
// avant « confirmé » — une confirmation d'un autre contexte n'est pas une relance évitée.
const DECIDE_PRESENCE = `
  UPDATE whatsapp_relances r SET decided_at = NOW(), outcome = CASE
      WHEN m.status <> 'assigned' OR m.oeil_id IS DISTINCT FROM r.user_id
        OR m.presence_confirmation_requested_at IS DISTINCT FROM r.request_at THEN 'skipped_obsolete'
      WHEN m.presence_confirmed_at IS NOT NULL THEN 'skipped_confirmed'
      WHEN m.presence_confirmation_deadline_at IS NULL OR m.presence_confirmation_deadline_at <= NOW() THEN 'skipped_obsolete'
      WHEN u.phone IS NULL OR btrim(u.phone) = '' THEN 'skipped_no_phone'
      ELSE 'sending' END
  FROM missions m, users u
  WHERE r.id = $1 AND r.decided_at IS NULL AND m.id = r.mission_id AND u.id = r.user_id
  RETURNING r.id, r.kind, r.outcome, m.id AS mission_id, m.title, m.presence_confirmation_deadline_at AS deadline_at, u.phone`;

const DECIDE_CLIENT = `
  UPDATE whatsapp_relances r SET decided_at = NOW(), outcome = CASE
      WHEN m.status <> 'pending' THEN 'skipped_obsolete'
      WHEN EXISTS (SELECT 1 FROM notifications n WHERE n.id = r.notification_id AND n.is_read) THEN 'skipped_read'
      WHEN m.client_interests_viewed_at >= COALESCE((SELECT n.created_at FROM notifications n WHERE n.id = r.notification_id), r.created_at) THEN 'skipped_viewed'
      WHEN u.phone IS NULL OR btrim(u.phone) = '' THEN 'skipped_no_phone'
      ELSE 'sending' END
  FROM missions m, users u
  WHERE r.id = $1 AND r.decided_at IS NULL AND m.id = r.mission_id AND u.id = r.user_id
  RETURNING r.id, r.kind, r.outcome, m.id AS mission_id, m.title, u.phone`;

async function processRelance(db, id, kind) {
  const presence = PRESENCE_KINDS[kind];
  const { rows: [row] } = await db.query(presence ? DECIDE_PRESENCE : DECIDE_CLIENT, [id]);
  if (!row) return null; // déjà décidée par un autre processus
  if (row.outcome !== 'sending') return row.outcome;

  let ok = false;
  try {
    let templateKey;
    let variables;
    if (presence) {
      templateKey = presence.template;
      const deadlineTime = new Date(row.deadline_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Casablanca' });
      variables = [row.title, deadlineTime];
    } else {
      templateKey = 'oeil_applied';
      // Nombre de candidatures d'Œils vérifiés AU MOMENT de l'envoi (même comptage que le seuil).
      // Même définition que le seuil et la liste client (utils/candidates.js).
      const n = await countVisibleForMissionId(db, row.mission_id);
      variables = [String(n), row.title];
    }
    ok = await wasel.sendWhatsAppTemplate(waselTemplates[templateKey].template_name, row.phone, variables, db, { missionId: row.mission_id });
  } catch (e) {
    console.error(`❌ Relance WhatsApp ${kind} — mission ${row.mission_id} :`, e.message);
  }
  const outcome = ok ? 'sent' : 'failed';
  await db.query(`UPDATE whatsapp_relances SET outcome = $2 WHERE id = $1 AND outcome = 'sending'`, [id, outcome]);
  console.log(`📲 Relance WhatsApp ${kind} — mission ${row.mission_id} : ${outcome}`);
  return outcome;
}

// Cron chaque minute (index.js). Renvoie le décompte des décisions de CE passage (tests).
async function runWhatsappRelances(db) {
  const { rows: due } = await db.query(
    `SELECT id, kind FROM whatsapp_relances WHERE decided_at IS NULL AND due_at <= NOW() ORDER BY due_at LIMIT ${BATCH}`
  );
  const summary = {};
  for (const r of due) {
    // Isolation par itération (RG9) : une relance en échec n'abandonne pas les suivantes.
    try {
      const outcome = await processRelance(db, r.id, r.kind);
      if (outcome) summary[outcome] = (summary[outcome] || 0) + 1;
    } catch (e) {
      console.error(`❌ Relance WhatsApp #${r.id} (${r.kind}) :`, e.message);
    }
  }
  return summary;
}

module.exports = { schedulePresenceRelance, scheduleClientAppliedRelance, runWhatsappRelances, PRESENCE_KINDS, CLIENT_KIND };
