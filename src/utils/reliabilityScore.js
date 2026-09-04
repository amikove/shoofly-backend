const { getDb } = require('../db/schema');
const { getSetting } = require('./settings');

// ── Pénalité proportionnelle au délai avant la mission ────
// Plus l'action (refus, annulation...) est tardive, plus elle désorganise
// le client et pèse sur la réputation de la plateforme. Barème partagé par
// toutes les routes qui pénalisent un abandon d'Œil sur une mission assignée.
// `asOfDate` (optionnel) : instant à partir duquel le préavis est mesuré. Par défaut Date.now()
// (comportement historique, inchangé pour l'appelant existant ci-dessous). PROMPT 1 point 5
// (2026-08-17) introduit un appelant qui juge une action a posteriori, parfois bien après
// scheduledAt lui-même (requalification admin d'une urgence) — il DOIT passer le vrai instant
// de l'action (ex: mission_assistance_requests.created_at), jamais laisser le défaut, sous peine
// de calculer un préavis négatif absurde et de tomber systématiquement dans le pire palier.
async function computeLatePenalty(db, scheduledAt, actionLabel, asOfDate = null) {
  const referenceTime = asOfDate ? new Date(asOfDate).getTime() : Date.now();
  const hoursBeforeMission = scheduledAt
    ? (new Date(scheduledAt).getTime() - referenceTime) / 3600000
    : null;
  const tier1Points = await getSetting(db, 'late_cancel_penalty_tier1_points', -15);
  const tier2Points = await getSetting(db, 'late_cancel_penalty_tier2_points', -35);
  const tier3Points = await getSetting(db, 'late_cancel_penalty_tier3_points', -50);
  const tier1ThresholdHours = await getSetting(db, 'late_cancel_penalty_tier1_threshold_hours', 24);
  const tier2ThresholdHours = await getSetting(db, 'late_cancel_penalty_tier2_threshold_hours', 2);
  // Palier 1 rendu délibérément inatteignable par défaut (PROMPT 1 point 5, 2026-08-17, section
  // 0/B4) : un préavis de tier1ThresholdHours ou plus ne coûte plus aucun point. Piloté par
  // réglage (late_cancel_penalty_tier1_enabled), pas une constante figée dans le code — voir
  // settingsDefaults.js — pour rester réactivable en un clic admin, sans déploiement, si
  // l'interprétation s'avérait fausse. tier1Points reste calculé ci-dessus, jamais supprimé.
  const tier1Enabled = (await getSetting(db, 'late_cancel_penalty_tier1_enabled', 'false')) === 'true';
  // C10 (audit valeurs-temps, 2026-09-03) : les libellés de palier sont dérivés des DEUX
  // réglages de seuil (late_cancel_penalty_tier1_threshold_hours / _tier2_threshold_hours) et
  // non plus figés « 24h » / « 2h » en dur. Sinon un admin qui change un seuil rend le champ
  // `reason` inséré dans reliability_events mensonger pour l'Œil pénalisé : il est affiché tel
  // quel dans son historique (CompteSuspendu.jsx via GET /reliability/me) et côté admin
  // (AdminFiabilite.jsx, UserProfile.jsx via GET /reliability/admin/:id/history et le profil).
  // Aux défauts (24 / 2) ces chaînes sont identiques au caractère près aux littéraux précédents
  // — aucun changement de comportement au déploiement. Format « Nh » conservé (jamais « N heure »)
  // pour ne pas percuter le KPI ILIKE '%heure%' de routes/users.js.
  let points, timing;
  if (hoursBeforeMission === null || hoursBeforeMission > tier1ThresholdHours) {
    if (tier1Enabled) {
      points = tier1Points; timing = `plus de ${tier1ThresholdHours}h avant`;
    } else {
      points = 0; timing = `plus de ${tier1ThresholdHours}h avant (préavis suffisant, aucune pénalité)`;
    }
  } else if (hoursBeforeMission > tier2ThresholdHours) {
    points = tier2Points; timing = `entre ${tier2ThresholdHours}h et ${tier1ThresholdHours}h avant`;
  } else {
    points = tier3Points; timing = `moins de ${tier2ThresholdHours}h avant, très tardif`;
  }
  return { points, reason: `Mission ${actionLabel} (${timing})`, isGrave: points <= tier2Points };
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
    // reverses_event_id IS NULL exclut les événements de compensation eux-mêmes ; le NOT IN
    // exclut l'événement d'origine qu'ils annulent — la paire entière disparaît du calcul (voir
    // reverseReliabilityEvent ci-dessous et schema.js), pas juste une addition de deltas opposés,
    // sinon le score dérive via le dénominateur de la moyenne (glissante 20 + historique) au lieu
    // de revenir exactement à sa valeur d'avant l'événement annulé.
    const { rows: rawEvents } = await db.query(
      `SELECT points, is_reset FROM reliability_events
       WHERE oeil_id=$1
         AND reverses_event_id IS NULL
         AND id NOT IN (
           SELECT reverses_event_id FROM reliability_events
           WHERE oeil_id=$1 AND reverses_event_id IS NOT NULL
         )
       ORDER BY created_at ASC`,
      [oeilId]
    );
    // Si un événement de reset (réintégration admin) existe, on ignore tout l'historique
    // avant lui — il reste consultable dans le détail des événements, mais ne compte plus dans le score actif.
    const lastResetIndex = rawEvents.map(e => e.is_reset).lastIndexOf(true);
    const allEvents = lastResetIndex >= 0 ? rawEvents.slice(lastResetIndex) : rawEvents;
    const totalMissions = allEvents.length;
  if (totalMissions === 0) return 90; // score de départ

  // Score historique complet
    // Chaque événement "normal" est plafonné à ±10 dans ce calcul : la formule suppose une
    // échelle -10/+10, donc une pénalité plus sévère (ex: -15, -25...) ne doit pas faire
    // s'effondrer le score de façon disproportionnée avec un petit historique — le barème réel
    // reste inchangé en base (reliability_events). L'événement de reset (réintégration) est
    // différent par nature : son `points` stocke directement le pourcentage cible exact (0-100),
    // pas un delta ±10 — le traiter comme un événement normal (÷10 puis ×10 lors de l'arrondi
    // en points entiers) perdait jusqu'à 5 points de précision (ex: cible 65% → 70% obtenu,
    // constaté empiriquement, audit scénario 5.3a). pctContribution() unifie les deux cas sur
    // une échelle 0-100 commune ; mathématiquement équivalent à l'ancienne formule pour tout
    // événement normal (clamp(points)*10 / totalMissions == clamp(points)/(totalMissions*10)*100).
    const clamp = (v) => Math.max(-10, Math.min(10, v));
    const pctContribution = (e) => e.is_reset ? e.points : clamp(e.points) * 10;
    const sumAll = allEvents.reduce((s, e) => s + pctContribution(e), 0);
    const scoreHistorique = totalMissions > 0 ? sumAll / totalMissions : 90;
    // Score sur les 20 dernières missions
    const last20 = allEvents.slice(-20);
    const sum20 = last20.reduce((s, e) => s + pctContribution(e), 0);
    const score20 = last20.length > 0 ? sum20 / last20.length : 90;

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
    // BE-4 constat 10 (2026-08-21) : ajoute la même réassurance d'accès que le message de
    // suspension manuelle (users.js) — depuis le constat 09 ci-dessous, les deux voies
    // retirent réellement les missions en cours, donc les deux méritent la même précision sur
    // ce qui reste accessible (connexion, demande d'examen).
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type, action_type, title_key, body_key, params)
       VALUES ($1, '🔴 Compte suspendu', 'Votre score de fiabilité est tombé en dessous de 50%. Vous conservez l''accès à votre compte : vous pouvez toujours vous connecter et demander un examen de votre dossier.', 'error', 'none', $2, $3, $4)`,
      [oeilId, 'accountAutoSuspendedTitle', 'accountAutoSuspendedBody', null]
    );

    // BE-4 constat 09 (2026-08-21) : aligne la suspension automatique par score sur la
    // suspension manuelle (PUT /admin/:id/toggle-active, users.js) — retrait des missions en
    // cours et réattribution via la même cascade de remplacement, réutilisée telle quelle (voir
    // reassignMissionsOnSuspension, routes/missions.js — commentaire sur cette fonction pour le
    // détail du require différé et de la tolérance io/emitToUser=null ci-dessous).
    const missionRoutes = require('../routes/missions');
    await missionRoutes.reassignMissionsOnSuspension(db, null, null, oeilId, {
      actorId: null,
      transferReason: 'Compte prestataire suspendu automatiquement — score de fiabilité sous 50%',
      historyNote: 'Réattribution automatique — suspension automatique par score de fiabilité',
    });
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
  // Son `points` stocke directement le pourcentage cible (0-100), lu tel quel par
  // computeReliabilityScore (pctContribution) — jamais divisé par 10 puis remultiplié, ce qui
  // limitait auparavant les cibles exactement atteignables aux seuls multiples de 10.
  const resetPoints = Math.round(Math.max(0, Math.min(100, targetScore)));
  await db.query(
    `INSERT INTO reliability_events (oeil_id, mission_id, points, reason, is_grave, is_reset)
     VALUES ($1, NULL, $2, $3, false, true)`,
    [oeilId, resetPoints, `Réintégration administrative — redémarrage à ${targetScore}%`]
  );

  const score = await computeReliabilityScore(db, oeilId);
  await db.query(`UPDATE users SET reliability_score=$1, is_suspended=false, suspended_at=NULL, suspended_reason=NULL WHERE id=$2`, [score, oeilId]);
  return score;
}

// ── Annuler intégralement un événement de fiabilité déjà appliqué ─
// N'écrase ni ne supprime jamais l'événement d'origine (il reste lisible tel quel par toute
// lecture directe de reliability_events, ex: reliabilityRoutes.js, users.js admin). Insère à la
// place un événement de compensation de poids strictement opposé (jamais un montant en dur —
// lu depuis l'événement réellement appliqué), référençant l'origine via reverses_event_id.
// computeReliabilityScore exclut la paire entière du calcul (voir plus haut), donc le score
// recalculé après coup redevient identique bit-à-bit à sa valeur d'avant l'événement d'origine,
// pour toujours (pas seulement au moment de l'appel — un futur recalcul ne peut pas régresser).
//
// Sélectionne le DERNIER événement non encore annulé correspondant à (oeilId, missionId, reason)
// — si ce (oeil, mission) a connu plusieurs cycles transfert/reprise dans le temps, les cycles
// précédents ont déjà leur propre compensation et sont donc déjà exclus par le NOT EXISTS,
// jamais re-matchés par erreur.
//
// Retourne l'événement d'origine (utile à l'appelant pour vérifier qu'il y avait bien quelque
// chose à annuler) ou null si aucun événement correspondant et non-annulé n'existe — l'appelant
// décide si ce cas est une anomalie (voir POST /:id/resume-after-h30, gardé par
// transfer_h30_no_show donc un événement DOIT exister) ou un no-op légitime.
async function reverseReliabilityEvent(db, oeilId, missionId, originalReason, newReason) {
  const { rows: [original] } = await db.query(
    `SELECT * FROM reliability_events
     WHERE oeil_id=$1 AND mission_id=$2 AND reason=$3
       AND NOT EXISTS (
         SELECT 1 FROM reliability_events r2 WHERE r2.reverses_event_id = reliability_events.id
       )
     ORDER BY created_at DESC LIMIT 1`,
    [oeilId, missionId, originalReason]
  );
  if (!original) return null;

  await db.query(
    `INSERT INTO reliability_events (oeil_id, mission_id, points, reason, is_grave, reverses_event_id)
     VALUES ($1, $2, $3, $4, false, $5)`,
    [oeilId, missionId, -original.points, newReason, original.id]
  );
  await checkAndUpdateSuspension(db, oeilId);
  return original;
}

module.exports = {
  logReliabilityEvent,
  computeReliabilityScore,
  checkAndUpdateSuspension,
  getReliabilityLevel,
  reactivateWithCorrectiveEvent,
  reverseReliabilityEvent,
  computeLatePenalty,
  isNewOeil,
  NEW_OEIL_MISSION_THRESHOLD,
};