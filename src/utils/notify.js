const push = require('../services/push');

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
async function notify(db, userId, title, body, type = 'info', missionId = null, emitToUser = null, actionType = null, titleKey = null, bodyKey = null, params = null) {
  const r = await db.query(
    `INSERT INTO notifications (user_id,title,body,type,mission_id,action_type,title_key,body_key,params) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [userId, title, body, type, missionId, actionType, titleKey, bodyKey, params ? JSON.stringify(params) : null]
  );
  if (emitToUser) emitToUser(userId, 'notification', r.rows[0]);

  // 3ᵉ canal — après l'in-app et le socket live. Jamais attendu, jamais bloquant, ne lève
  // jamais (services/push.js avale tout). `tag` dédupe côté navigateur si l'utilisateur est
  // multi-appareils et déjà en train de lire.
  push.sendWebPush(userId, {
    title,
    body,
    url: push.deepLinkFor(actionType, missionId),
    tag: `notif-${r.rows[0].id}`,
    urgent: type === 'error',
    notificationId: r.rows[0].id,
    eventKey: titleKey || null,
  }).catch(() => {});
}

module.exports = { notify };
