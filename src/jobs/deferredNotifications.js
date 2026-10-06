// Envoi des notifications non urgentes reportées par la plage de silence (utils/quietHours.js).
// Cron chaque minute (index.js). Sûr à plusieurs processus : chaque ligne est réservée par
// UPDATE ... FOR UPDATE SKIP LOCKED (un seul processus la prend). Une ligne réservée puis
// interrompue (crash pendant l'envoi) est reprise après 5 min : rejeu possible, jamais de perte.
// La file est en base, donc un redémarrage du serveur ne fait rien perdre.
const { notify } = require('../utils/notify');

const CLAIM_TIMEOUT_MINUTES = 5;
const BATCH_SIZE = 200;

async function runDeferredNotifications(db, emitToUser = null) {
  const { rows } = await db.query(`
    UPDATE deferred_notifications SET claimed_at = NOW()
    WHERE id IN (
      SELECT id FROM deferred_notifications
      WHERE deliver_at <= NOW()
        AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '1 minute' * $1::numeric)
      ORDER BY deliver_at, id
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, payload`, [CLAIM_TIMEOUT_MINUTES, BATCH_SIZE]);

  let sent = 0;
  for (const row of rows) {
    const p = row.payload;
    try {
      await notify(db, p.userId, p.title, p.body, p.type, p.missionId, emitToUser, p.actionType, p.titleKey, p.bodyKey, p.params, p.pushOptions);
      await db.query('DELETE FROM deferred_notifications WHERE id = $1', [row.id]);
      sent++;
    } catch (e) {
      console.error(`❌ Notification différée ${row.id} :`, e.message);
    }
  }
  if (sent > 0) console.log(`📬 Notifications différées envoyées : ${sent}`);
  return sent;
}

module.exports = { runDeferredNotifications };
