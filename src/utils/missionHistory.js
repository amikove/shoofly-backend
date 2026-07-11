async function logStatus(db, missionId, status, userId, note = null) {
  await db.query(
    `INSERT INTO mission_status_history (mission_id, status, changed_by, note) VALUES ($1, $2, $3, $4)`,
    [missionId, status, userId, note]
  );
}

module.exports = { logStatus };
