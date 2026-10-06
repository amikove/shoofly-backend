// Marqueur d'idempotence du rappel « mission à vérifier » (missions.to_verify_notified_at).
// Appelé UNE SEULE FOIS au déploiement (runDataMigrationOnce dans db/schema.js) : les missions déjà
// en retard sont marquées sans être notifiées, pour qu'aucune vague ne parte en prod à la mise en ligne.
async function markOverdueToVerifyAsNotified(client, hours) {
  const { rowCount } = await client.query(
    `UPDATE missions SET to_verify_notified_at = NOW()
     WHERE to_verify_notified_at IS NULL
       AND status IN ('active', 'en_route')
       AND oeil_id IS NOT NULL
       AND scheduled_at < NOW() - INTERVAL '1 hour' * $1::numeric`,
    [hours]
  );
  return rowCount;
}

module.exports = { markOverdueToVerifyAsNotified };
