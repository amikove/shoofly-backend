// Alerte « mission sans Œil » (audit notifications, décision BOSS 2026-10-06, point 1).
//
// Condition (inchangée) : mission 'pending', aucun Œil assigné, créée il y a au moins
// stale_mission_hours, dont le créneau est à au moins stale_mission_min_lead_hours, alerte jamais
// envoyée. Le texte affiche la VALEUR RÉELLE du réglage (jamais « 12 h » en dur) et le nombre de
// candidatures tel que le client le voit (utils/candidates.js, définition unique).
//
// - Admin : alerte immédiate (in-app, push, WhatsApp mission_sans_oeil_admin inchangé).
// - Client : envoyée SEULEMENT si la mission n'a aucune candidature visible, puis reportée par la
//   plage de silence (notifyDifferable) sauf mission imminente.
const { getSetting } = require('../utils/settings');
const { notify, notifyDifferable } = require('../utils/notify');
const { listClientVisibleCandidates } = require('../utils/candidates');
const { sendWhatsAppTemplate } = require('../services/wasel');
const waselTemplates = require('../config/waselTemplates');

async function runStaleMissions(db, emitToUser = null) {
  const staleMissionHours = await getSetting(db, 'stale_mission_hours', 12);
  const staleMissionMinLeadHours = await getSetting(db, 'stale_mission_min_lead_hours', 4);

  const { rows: staleMissions } = await db.query(`
    SELECT * FROM missions
    WHERE status = 'pending'
      AND oeil_id IS NULL
      AND created_at <= NOW() - INTERVAL '1 hour' * $1::numeric
      AND scheduled_at >= NOW() + INTERVAL '1 hour' * $2::numeric
      AND stale_notified_at IS NULL
  `, [staleMissionHours, staleMissionMinLeadHours]);

  // Un seul SELECT admins par tick, réutilisé pour chaque mission (audit perf 2026-07-26).
  const { rows: admins } = await db.query(`SELECT id, phone FROM users WHERE role='admin' AND is_active=true`);
  let alerted = 0;
  for (const m of staleMissions) {
    try {
      // Garde d'idempotence AVANT les effets : une seule alerte par mission.
      const { rowCount } = await db.query(
        `UPDATE missions SET stale_notified_at = NOW() WHERE id = $1 AND stale_notified_at IS NULL`,
        [m.id]
      );
      if (rowCount === 0) continue;

      const candidatures = (await listClientVisibleCandidates(db, m)).length;
      const params = { missionTitle: m.title, hours: staleMissionHours, count: candidatures };

      for (const admin of admins) {
        await notify(
          db, admin.id,
          `⏳ Mission sans Œil depuis ${staleMissionHours} h`,
          `Aucun Œil assigné à "${m.title}" depuis plus de ${staleMissionHours} h. ${candidatures} candidature(s) reçue(s).`,
          'warning', m.id, emitToUser, 'admin_missions',
          'staleMissionAdminTitle', 'staleMissionAdminBody', params
        );
        if (admin.phone) {
          await sendWhatsAppTemplate(waselTemplates.mission_without_oeil_admin.template_name, admin.phone, [m.title], db, { missionId: m.id });
        }
      }

      // Client : seulement si aucune candidature visible (sinon le client a déjà de quoi agir :
      // « Des Œils ont postulé » / « Nouvel Œil intéressé »).
      if (candidatures === 0) {
        await notifyDifferable(
          db, m.client_id,
          `💡 Toujours aucun Œil pour votre mission`,
          `Votre mission "${m.title}" n'a reçu aucune candidature depuis ${staleMissionHours} h. Augmenter le budget peut attirer plus de candidats. Consultez votre mission pour l'ajuster.`,
          'warning', m.id, emitToUser, 'mission_view',
          'staleMissionClientTitle', 'staleMissionClientBody', { missionTitle: m.title, hours: staleMissionHours },
          null, m.scheduled_at
        );
      }
      alerted++;
    } catch (e) {
      console.error(`❌ Cron missions sans Œil — mission ${m.id} :`, e.message);
    }
  }
  return alerted;
}

module.exports = { runStaleMissions };
