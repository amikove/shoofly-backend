// ── Temps de réponse moyen d'un Œil ────────────────────────
// Calculé sur mission_messages : un "tour" va du premier message non répondu
// (envoyé par le client ou un admin) jusqu'à la prochaine réponse de l'Œil,
// tous types de mission confondus. Seuls les messages type='text' comptent —
// les messages système (changements de statut...) et de localisation (pings
// GPS automatiques) ne reflètent pas une réactivité humaine.
const MAX_VALID_DELAY_MINUTES = 24 * 60;
const MIN_VALID_TURNS = 3;

// ── Calcul groupé pour une liste d'Œils ────────────────────
// Une seule requête SQL (fenêtres analytiques) plutôt que N requêtes en boucle :
// nécessaire pour InterestsModal qui affiche plusieurs candidats simultanément.
// La requête détecte les "tours" via un regroupement de messages consécutifs de
// même direction (in/out) par mission, puis apparie chaque run 'out' avec le run
// 'in' qui le précède immédiatement (les runs alternent forcément une fois groupés).
async function computeAvgResponseMinutesBulk(db, oeilIds) {
  const ids = [...new Set((oeilIds || []).filter(Boolean))];
  const result = {};
  if (ids.length === 0) return result;

  const { rows } = await db.query(
    `WITH msgs AS (
       SELECT m.oeil_id AS target_oeil, mm.mission_id, mm.created_at,
              CASE WHEN mm.sender_id = m.oeil_id THEN 'out' ELSE 'in' END AS direction
       FROM mission_messages mm
       JOIN missions m ON m.id = mm.mission_id
       WHERE mm.type = 'text' AND m.oeil_id = ANY($1::text[])
     ),
     lagged AS (
       SELECT *,
         LAG(direction) OVER (PARTITION BY target_oeil, mission_id ORDER BY created_at) AS prev_direction
       FROM msgs
     ),
     runs AS (
       SELECT *,
         SUM(CASE WHEN direction = prev_direction THEN 0 ELSE 1 END)
           OVER (PARTITION BY target_oeil, mission_id ORDER BY created_at) AS run_id
       FROM lagged
     ),
     run_bounds AS (
       SELECT target_oeil, mission_id, run_id, direction, MIN(created_at) AS run_start
       FROM runs
       GROUP BY target_oeil, mission_id, run_id, direction
     ),
     paired AS (
       SELECT target_oeil, mission_id, direction, run_start,
         LAG(direction)  OVER (PARTITION BY target_oeil, mission_id ORDER BY run_id) AS prev_direction,
         LAG(run_start)  OVER (PARTITION BY target_oeil, mission_id ORDER BY run_id) AS prev_start
       FROM run_bounds
     ),
     turns AS (
       SELECT target_oeil,
              EXTRACT(EPOCH FROM (run_start - prev_start)) / 60.0 AS delay_minutes
       FROM paired
       WHERE direction = 'out' AND prev_direction = 'in'
     )
     SELECT target_oeil, COUNT(*) AS turn_count, AVG(delay_minutes) AS avg_minutes
     FROM turns
     WHERE delay_minutes <= $2
     GROUP BY target_oeil`,
    [ids, MAX_VALID_DELAY_MINUTES]
  );

  for (const row of rows) {
    const turnCount = Number(row.turn_count);
    result[row.target_oeil] = turnCount >= MIN_VALID_TURNS ? Math.round(Number(row.avg_minutes)) : null;
  }
  for (const id of ids) {
    if (!(id in result)) result[id] = null;
  }
  return result;
}

// ── Calcul pour un seul Œil ─────────────────────────────────
async function computeAvgResponseMinutes(db, oeilId) {
  const result = await computeAvgResponseMinutesBulk(db, [oeilId]);
  return result[oeilId] ?? null;
}

module.exports = {
  computeAvgResponseMinutes,
  computeAvgResponseMinutesBulk,
  MAX_VALID_DELAY_MINUTES,
  MIN_VALID_TURNS,
};
