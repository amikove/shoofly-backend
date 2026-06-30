const { getDb } = require('./schema');
const { logReliabilityEvent } = require('../utils/reliabilityScore');

// ── Script de test : simule un historique de missions pour un Œil ──
// Usage : node src/db/seedReliabilityTest.js <oeil_id>

async function seedReliabilityTest(oeilId) {
  const db = getDb();

  const { rows: [oeil] } = await db.query('SELECT * FROM users WHERE id=$1 AND role=\'oeil\'', [oeilId]);
  if (!oeil) {
    console.log('❌ Œil introuvable');
    process.exit(1);
  }

  console.log(`🎯 Simulation pour ${oeil.first_name} ${oeil.last_name}`);

  // Nettoyer l'historique existant pour repartir propre
  await db.query('DELETE FROM reliability_events WHERE oeil_id=$1', [oeilId]);
  await db.query('UPDATE users SET is_suspended=false, suspended_at=NULL, suspended_reason=NULL WHERE id=$1', [oeilId]);

  const scenarios = [
    // 10 missions honorées correctement (notes 4-5)
    ...Array(10).fill().map((_, i) => ({ points: 10, reason: `Mission honorée parfaitement #${i + 1}`, grave: false })),

    // 5 missions à moitié honorées (note 3)
    ...Array(5).fill().map((_, i) => ({ points: 5, reason: `Mission avec souci mineur #${i + 1}`, grave: false })),

    // 3 missions mal notées (note 1-2)
    ...Array(3).fill().map((_, i) => ({ points: 0, reason: `Mission mal notée par le client #${i + 1}`, grave: true })),

    // 2 transferts avant démarrage avec remplaçant trouvé
    ...Array(2).fill().map((_, i) => ({ points: 5, reason: `Transfert avant démarrage avec remplaçant #${i + 1}`, grave: false })),

    // 2 transferts pendant mission SANS remplaçant (faute grave)
    ...Array(2).fill().map((_, i) => ({ points: -20, reason: `Transfert pendant mission sans remplaçant #${i + 1}`, grave: true })),

    // 1 mission non démarrée à l'heure
    { points: -20, reason: 'Mission non démarrée à l\'heure (H+30)', grave: true },
  ];

  for (const s of scenarios) {
    await logReliabilityEvent(db, oeilId, null, s.points, s.reason, s.grave);
  }

  const { rows: [updated] } = await db.query('SELECT reliability_score, is_suspended FROM users WHERE id=$1', [oeilId]);

  console.log(`\n✅ Simulation terminée`);
  console.log(`📊 Score final : ${updated.reliability_score}%`);
  console.log(`🔴 Suspendu : ${updated.is_suspended ? 'OUI' : 'NON'}`);
  console.log(`\nTotal événements créés : ${scenarios.length}`);

  process.exit(0);
}

const oeilId = process.argv[2];
if (!oeilId) {
  console.log('Usage: node src/db/seedReliabilityTest.js <oeil_id>');
  process.exit(1);
}

seedReliabilityTest(oeilId).catch(e => {
  console.error('❌ Erreur:', e.message);
  process.exit(1);
});