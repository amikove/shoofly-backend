const { getDb } = require('../db/schema');

// ── Pénalité proportionnelle au délai avant la mission ────
// Plus l'action (refus, annulation...) est tardive, plus elle désorganise
// le client et pèse sur la réputation de la plateforme. Barème partagé par
// toutes les routes qui pénalisent un abandon d'Œil sur une mission assignée.
function computeLatePenalty(scheduledAt, actionLabel) {
  const hoursBeforeMission = scheduledAt
    ? (new Date(scheduledAt).getTime() - Date.now()) / 3600000
    : null;
  let points, timing;
  if (hoursBeforeMission === null || hoursBeforeMission > 24) {
    points = -15; timing = 'plus de 24h avant';
  } else if (hoursBeforeMission > 2) {
    points = -35; timing = 'entre 2h et 24h avant';
  } else {
    points = -50; timing = 'moins de 2h avant, très tardif';
  }
  return { points, reason: `Mission ${actionLabel} (${timing})`, isGrave: points <= -35 };
}

// ── Enregistrer un événement de fiabilité ─────────────────
async function logReliabilityEvent(db, oeilId, missionId, points, reason, isGrave = false) {
  await db.query(
    `INSERT INTO reliability_events (oeil_id, mission_id, points, reason, is_grave)
     VALUES ($1, $2, $3, $4, $5)`,
    [oeilId, missionId, points, reason, isGrave]
  );
  await checkAndUpdateSuspension(db, oeilId);
}

// ── Calculer le score d'un Œil ────────────────────────────
async function computeReliabilityScore(db, oeilId) {
    const { rows: rawEvents } = await db.query(
      `SELECT points, is_reset FROM reliability_events WHERE oeil_id=$1 ORDER BY created_at ASC`,
      [oeilId]
    );
    // Si un événement de reset (réintégration admin) existe, on ignore tout l'historique
    // avant lui — il reste consultable dans le détail des événements, mais ne compte plus dans le score actif.
    const lastResetIndex = rawEvents.map(e => e.is_reset).lastIndexOf(true);
    const allEvents = lastResetIndex >= 0 ? rawEvents.slice(lastResetIndex) : rawEvents;
    const totalMissions = allEvents.length;
  if (totalMissions === 0) return 90; // score de départ

  // Score historique complet
    // Chaque événement est plafonné à ±10 dans ce calcul : la formule suppose une échelle -10/+10,
    // donc une pénalité plus sévère (ex: -15, -25...) ne doit pas faire s'effondrer le score de façon
    // disproportionnée avec un petit historique — le barème réel reste inchangé en base (reliability_events).
    const clamp = (v) => Math.max(-10, Math.min(10, v));
    const sumAll = allEvents.reduce((s, e) => s + clamp(e.points), 0);
    const maxAll = totalMissions * 10;
    const scoreHistorique = maxAll > 0 ? (sumAll / maxAll) * 100 : 90;
    // Score sur les 20 dernières missions
    const last20 = allEvents.slice(-20);
    const sum20 = last20.reduce((s, e) => s + clamp(e.points), 0);
    const max20 = last20.length * 10;
    const score20 = max20 > 0 ? (sum20 / max20) * 100 : 90;

  // Pondération : 70% récent, 30% historique
  let finalScore = (0.7 * score20) + (0.3 * scoreHistorique);

  // Plancher protégé pour débutants (< 10 missions)
  // Le plancher doit rester au-dessus du seuil de suspension (50) pour vraiment protéger
    // un débutant d'une suspension automatique après une seule erreur, même grave.
    const plancher = totalMissions < 10 ? 55 : 0;

  finalScore = Math.max(plancher, Math.min(100, finalScore));

  return Math.round(finalScore);
}

// ── Vérifier et appliquer suspension automatique ──────────
async function checkAndUpdateSuspension(db, oeilId) {
  const score = await computeReliabilityScore(db, oeilId);

  await db.query(
    `UPDATE users SET reliability_score=$1 WHERE id=$2`,
    [score, oeilId]
  );

  const { rows: [user] } = await db.query(
    `SELECT is_suspended FROM users WHERE id=$1`, [oeilId]
  );

  if (score < 50 && !user.is_suspended) {
    await db.query(
      `UPDATE users SET is_suspended=true, suspended_at=NOW(), suspended_reason='Score de fiabilité inférieur à 50%' WHERE id=$1`,
      [oeilId]
    );
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
       VALUES ($1, '🔴 Compte suspendu', 'Votre score de fiabilité est tombé en dessous de 50%. Vous pouvez demander un examen de votre dossier.', 'error', 'none', $2, $3, $4)`,
      [oeilId, 'accountAutoSuspendedTitle', 'accountAutoSuspendedBody', null]
    );
  } else if (score >= 50 && user.is_suspended) {
    // Le score est remonté naturellement au-dessus de 50 — ne pas réactiver automatiquement,
    // l'admin garde le contrôle final sur la réactivation après suspension
  }

  return score;
}

// ── Statut "nouveau" ────────────────────────────────────────
// Un Œil avec moins de NEW_OEIL_MISSION_THRESHOLD missions n'a pas assez
// d'historique pour qu'un score/note affiché à un tiers soit significatif —
// utilisé par les routes exposant un Œil à un client ou un autre Œil pour
// remplacer le score par un badge "Nouveau" plutôt qu'un chiffre trompeur.
const NEW_OEIL_MISSION_THRESHOLD = 10;
function isNewOeil(totalMissions, threshold = NEW_OEIL_MISSION_THRESHOLD) {
  return (totalMissions || 0) < threshold;
}

// ── Niveaux et badges ──────────────────────────────────────
function getReliabilityLevel(score) {
  if (score >= 95) return { label: 'Excellent', stars: 5, badge: '⭐⭐⭐⭐⭐', color: 'green' };
  if (score >= 90) return { label: 'Très bon',   stars: 4, badge: '⭐⭐⭐⭐',  color: 'teal' };
  if (score >= 80) return { label: 'Bon',        stars: 3, badge: '⭐⭐⭐',   color: 'blue' };
  if (score >= 70) return { label: 'À surveiller', stars: 2, badge: '⭐⭐', color: 'amber' };
  if (score >= 50) return { label: 'Critique',   stars: 1, badge: '⭐',     color: 'red' };
  return { label: 'Suspendu', stars: 0, badge: '🔴', color: 'red' };
}

// Réintégration : insère un événement correctif dont le poids ramène le score recalculé
// à la valeur cible voulue par l'admin — garde l'historique complet et honnête,
// plutôt que d'écraser reliability_score directement (ce qui serait effacé au prochain événement).
async function reactivateWithCorrectiveEvent(db, oeilId, targetScore, adminId) {
  // Événement de "reset" : le calcul du score ignorera tout l'historique avant ce point.
  // Le point de l'événement (targetScore/10, entre 0 et 10) reste dans les bornes du clamp ±10,
  // donc il compte pour sa pleine valeur au recalcul — pas de plafonnement qui viendrait l'annuler.
  const resetPoints = Math.round(Math.max(0, Math.min(100, targetScore)) / 10);
  await db.query(
    `INSERT INTO reliability_events (oeil_id, mission_id, points, reason, is_grave, is_reset)
     VALUES ($1, NULL, $2, $3, false, true)`,
    [oeilId, resetPoints, `Réintégration administrative — redémarrage à ${targetScore}%`]
  );

  const score = await computeReliabilityScore(db, oeilId);
  await db.query(`UPDATE users SET reliability_score=$1, is_suspended=false, suspended_at=NULL, suspended_reason=NULL WHERE id=$2`, [score, oeilId]);
  return score;
}

module.exports = {
  logReliabilityEvent,
  computeReliabilityScore,
  checkAndUpdateSuspension,
  getReliabilityLevel,
  reactivateWithCorrectiveEvent,
  computeLatePenalty,
  isNewOeil,
  NEW_OEIL_MISSION_THRESHOLD,
};