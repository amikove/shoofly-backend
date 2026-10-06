// Rappel « mission à vérifier » (cron horaire, index.js). Une seule notification par mission et par
// admin : garde d'idempotence to_verify_notified_at, posée AVANT les envois (comme stale_notified_at).
// Avant : le cron re-notifiait chaque admin à chaque passage tant que la mission restait en
// active/en_route → 24 passages × admins par jour et par mission.
const { getSetting } = require('../utils/settings');
const { notify } = require('../utils/notify');

async function runMissionToVerify(db, emitToUser = null) {
  const overdueVerificationHours = await getSetting(db, 'mission_overdue_verification_hours', 24);
  const { rows: expired } = await db.query(`
    SELECT m.id, m.title, u.first_name, u.last_name
    FROM missions m
    JOIN users u ON u.id = m.oeil_id
    WHERE m.status IN ('active', 'en_route')
      AND m.scheduled_at < NOW() - INTERVAL '1 hour' * $1::numeric
      AND m.oeil_id IS NOT NULL
      AND m.to_verify_notified_at IS NULL
  `, [overdueVerificationHours]);

  const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
  let alerted = 0;
  for (const m of expired) {
    try {
      // Garde d'idempotence AVANT les effets : une seule alerte par mission.
      const { rowCount } = await db.query(
        `UPDATE missions SET to_verify_notified_at = NOW() WHERE id = $1 AND to_verify_notified_at IS NULL`,
        [m.id]
      );
      if (rowCount === 0) continue;
      for (const admin of admins) {
        await notify(
          db, admin.id,
          '🔍 Mission à vérifier',
          `La mission "${m.title}" de ${m.first_name} ${m.last_name} dont l'heure prévue est dépassée de plus de ${overdueVerificationHours} h. Vérification requise.`,
          'warning', m.id, emitToUser, 'admin_missions',
          'missionToVerifyAdminTitle', 'missionToVerifyAdminBody',
          { missionTitle: m.title, oeilName: `${m.first_name} ${m.last_name}`, hours: overdueVerificationHours }
        );
      }
      alerted++;
    } catch (e) {
      console.error(`❌ Cron missions à vérifier — mission ${m.id} :`, e.message);
    }
  }
  return alerted;
}

module.exports = { runMissionToVerify };
