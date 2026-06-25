const router = require('express').Router();
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');

// ── GET /api/reports/:missionId ───────────────────────────
router.get('/:missionId', authenticate, async (req, res) => {
  const db = getDb();

  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1', [req.params.missionId]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

  const canView = req.user.role === 'admin'
    || mission.client_id === req.user.id
    || mission.oeil_id === req.user.id;
  if (!canView) return res.status(403).json({ error: 'Accès refusé' });

  const { rows: [report] } = await db.query(
    'SELECT * FROM airbnb_reports WHERE mission_id=$1', [req.params.missionId]
  );

  res.json({ report: report || null });
});

// ── POST /api/reports/:missionId ──────────────────────────
router.post('/:missionId', authenticate, requireRole('oeil'), async (req, res) => {
  const db = getDb();
  const { data, submitted } = req.body;

  const { rows: [mission] } = await db.query(
    'SELECT * FROM missions WHERE id=$1', [req.params.missionId]
  );
  if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
  if (mission.oeil_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });

  // Calculer le score
  const score = calculateScore(data);

  const { rows: [report] } = await db.query(
    `INSERT INTO airbnb_reports (mission_id, oeil_id, data, score, submitted)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (mission_id) DO UPDATE
     SET data=$3, score=$4, submitted=$5, updated_at=NOW()
     RETURNING *`,
    [req.params.missionId, req.user.id, JSON.stringify(data), score, submitted || false]
  );

  // Si soumis, notifier le client
  if (submitted) {
    const emitToUser = req.app.get('emitToUser');
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, mission_id)
       VALUES ($1, '📋 Rapport de visite disponible', $2, 'info', $3)`,
      [mission.client_id, `Le rapport de visite pour "${mission.title}" est prêt.`, req.params.missionId]
    );
    if (emitToUser) emitToUser(mission.client_id, 'notification', {
      title: '📋 Rapport de visite disponible',
      body: `Le rapport pour "${mission.title}" est prêt.`,
      missionId: req.params.missionId
    });
  }

  res.json({ report });
});

// ── Calcul du score ───────────────────────────────────────
function calculateScore(data) {
  if (!data) return 0;
  let score = 0;

  // Propreté /20
  if (data.proprete_note) score += (data.proprete_note / 5) * 12;
  if (data.sols_propres === 'oui') score += 2;
  if (data.sdb_propre === 'oui') score += 2;
  if (data.literie_propre === 'oui') score += 2;
  if (data.odeurs === 'non') score += 2;

  // Conformité annonce /15
  if (data.conformite === 'oui') score += 15;
  else if (data.conformite === 'partiellement') score += 8;
  else if (data.photos_conformite === 'conformes') score += 5;

  // Confort /15
  if (data.confort_lit) score += (data.confort_lit / 5) * 5;
  if (data.confort_canape) score += (data.confort_canape / 5) * 5;
  if (data.confort_global) score += (data.confort_global / 5) * 5;

  // Équipements /15
  const equip = [
    data.wifi, data.clim, data.eau_chaude, data.tv,
    data.refrigerateur, data.micro_onde, data.machine_laver
  ];
  const equipScore = equip.filter(e => e === 'oui' || e === 'fonctionnelle' || e === 'disponible').length;
  score += (equipScore / equip.length) * 15;

  // Bruit /10
  if (data.bruit_exterieur) score += (data.bruit_exterieur / 5) * 5;
  if (data.isolation_phonique) score += (data.isolation_phonique / 5) * 5;

  // Sécurité /10
  if (data.securite_note) score += (data.securite_note / 5) * 4;
  if (data.porte_securisee === 'oui') score += 3;
  if (data.quartier_rassurant === 'oui') score += 3;

  // Environnement /10
  if (data.restaurants) score += (data.restaurants / 5) * 2.5;
  if (data.commerces) score += (data.commerces / 5) * 2.5;
  if (data.transports) score += (data.transports / 5) * 2.5;
  if (data.interet_touristique) score += (data.interet_touristique / 5) * 2.5;

  // Luminosité /5
  if (data.luminosite) score += (data.luminosite / 5) * 5;

  return Math.min(100, Math.round(score));
}

module.exports = router;