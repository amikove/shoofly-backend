const push = require('../services/push');
const notifI18n = require('../i18n');

// action_type dont le deep-link dépend du rôle du destinataire (chemin /oeil/... vs
// /client/...) — seuls ceux-ci (ou une notification traduisible, voir la langue plus bas)
// justifient une lecture de la ligne users avant le push. Voir push.js deepLinkFor.
const ROLE_AWARE_ACTION_TYPES = new Set(['mission_view', 'chat', 'ticket_view', 'mes_signalements']);

// Limiteur de concurrence du canal push (chantier 2, 2026-09-26 — fan-out SC-5/C-13) : une
// création de mission notifie tous les Œils éligibles de la ville d'un coup (Promise.all) ; sans
// borne, chaque notification lançait aussitôt ses lectures + son POST push, en rafale sur le pool
// et vers le fournisseur. Au plus PUSH_CONCURRENCY envois push en vol par processus ; les
// suivants attendent leur tour (l'in-app et le socket, eux, ne sont jamais retardés).
const PUSH_CONCURRENCY = 10;
let pushActive = 0;
const pushQueue = [];
function limitPush(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      pushActive++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        pushActive--;
        const next = pushQueue.shift();
        if (next) next();
      });
    };
    if (pushActive < PUSH_CONCURRENCY) run(); else pushQueue.push(run);
  });
}

// Canal push d'une notification déjà insérée. UNE seule lecture de la ligne users (rôle pour le
// deep-link + langue pour le texte), et seulement si l'un des deux sert. Langue (chantier langue
// des notifications push, 2026-09-23) : titre/corps localisés pour ce SEUL canal — la ligne
// `notifications` reste FRANÇAISE (Topbar.jsx la retraduit via title_key/body_key). Repli sur
// title/body bruts si la langue est inconnue ou la clé absente du catalogue backend/src/i18n.
// Lecture en échec : on pousse quand même (texte français, deep-link générique).
async function sendPushFor(db, row, { userId, title, body, type, missionId, actionType, titleKey, bodyKey, params, pushOptions }) {
  let role = null;
  let language = null;
  if (ROLE_AWARE_ACTION_TYPES.has(actionType) || titleKey || bodyKey) {
    try {
      const { rows: [u] } = await db.query('SELECT role, language FROM users WHERE id=$1', [userId]);
      role = u ? u.role : null;
      language = u ? u.language : null;
    } catch { /* best-effort — jamais bloquant pour le push */ }
  }
  let pushTitle = title;
  let pushBody = body;
  if (language) {
    if (titleKey) pushTitle = notifI18n.t(titleKey, language, params) ?? title;
    if (bodyKey) pushBody = notifI18n.t(bodyKey, language, params) ?? body;
  }
  return push.sendWebPush(userId, {
    title: pushTitle,
    body: pushBody,
    url: push.deepLinkFor(actionType, missionId, { role, titleKey, params }),
    tag: `notif-${row.id}`,
    urgent: type === 'error',
    notificationId: row.id,
    eventKey: titleKey || null,
    urgency: pushOptions && pushOptions.urgency,
    ttl: pushOptions && pushOptions.ttl,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Point d'insertion UNIQUE des notifications utilisateur. Écrit la ligne in-app (table
// `notifications`), pousse le socket live si `emitToUser` est fourni, puis tente le canal push
// (best-effort). Extrait ici depuis routes/missions.js (où il vivait, dupliqué à l'identique
// dans routes/tickets.js) pour que TOUT événement qui notifie — ~45 sites recensés par
// rapport-chantier-audit-notifications-matrice-2026-09-08.md — gagne le push d'un seul endroit,
// sans toucher les sites d'appel.
//
// Signature INCHANGÉE par rapport à l'ancienne fonction locale de missions.js — aucun appelant
// n'a été modifié, missions.js ré-exporte toujours `router.notify = notify` (import inchangé
// dans index.js).
//
// Contrat push (voir services/push.js) : ne lève jamais, ne bloque pas la réponse HTTP
// (pas de `await` sur le push), silencieux si aucun abonnement / VAPID non configuré.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// pushOptions (chantier 2, 2026-09-26) : { urgency?, ttl? } — options de LIVRAISON du push
// (en-têtes Urgency / TTL), sans effet sur l'in-app. Utilisé par la sollicitation de cascade
// (urgency 'high', ttl = délai de confirmation) ; absent partout ailleurs → comportement d'avant.
//
// Valeur de retour (chantier 2 lot 1 bis, 2026-09-27) : la ligne de la table notifications insérée — les
// relances WhatsApp (jobs/whatsappRelances.js) s'y rattachent (lecture, mesure). Les appelants
// existants l'ignorent.
async function notify(db, userId, title, body, type = 'info', missionId = null, emitToUser = null, actionType = null, titleKey = null, bodyKey = null, params = null, pushOptions = null) {
  const r = await db.query(
    `INSERT INTO notifications (user_id,title,body,type,mission_id,action_type,title_key,body_key,params) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [userId, title, body, type, missionId, actionType, titleKey, bodyKey, params ? JSON.stringify(params) : null]
  );
  if (emitToUser) emitToUser(userId, 'notification', r.rows[0]);

  // 3ᵉ canal — après l'in-app et le socket live. Push inerte (VAPID absentes) → rien de plus :
  // plus aucune lecture users pour un envoi qui n'aurait pas lieu (SC-5). Sinon : jamais
  // attendu, jamais bloquant, ne lève jamais ; concurrence bornée (limitPush). `tag` dédupe côté
  // navigateur si l'utilisateur est multi-appareils et déjà en train de lire.
  const row = r.rows[0];
  if (!push.isPushConfigured()) return row;
  limitPush(() => sendPushFor(db, row, { userId, title, body, type, missionId, actionType, titleKey, bodyKey, params, pushOptions }))
    .catch(() => {});
  return row;
}

module.exports = { notify };
