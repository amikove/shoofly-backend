// Strikes no-show client (PROMPT 2 point 6, 2026-08-17 — section 0) — voir schema.js
// (users.client_noshow_strikes, client_strikes) et routes/users.js (PUT /admin/claims/
// :missionId/resolve). Un strike n'est JAMAIS posé depuis la clôture silencieuse à 12h
// (checkAssistanceRequestExpiry) — uniquement depuis une résolution admin explicite en faveur de
// l'Œil pour un litige "client absent/injoignable". Découplé de la décision commission (débit/
// libération) : les deux sont deux actions indépendantes, appliquées à des moments potentiellement
// différents — voir PUT /admin/claims/:missionId/resolve et POST /admin/claims/:missionId/commission.

// `db` : pool ou client de transaction déjà ouvert (même contrat que le reste du projet) — les
// écritures ci-dessous doivent rester atomiques avec la résolution du litige qui les déclenche,
// donc appelée depuis l'intérieur de la même transaction côté appelant.
//
// Blocage basé sur la transition réelle is_active (true->false), pas sur "count===2" : un
// compte réintégré par un admin puis retombant à un strike ultérieur (count=3, 4...) doit
// pouvoir se re-bloquer et re-notifier, pas seulement au tout premier franchissement du seuil.
// 1er strike (count=1) : jamais de blocage, avertissement seul (géré par l'appelant). count>=2
// avec le compte encore actif : blocage + justBlocked=true (l'appelant notifie admin+client et
// gère l'apparition dans l'onglet "Clients suspendus").
async function applyClientStrike(db, clientId, missionId, reason, createdBy) {
  const { rows: [before] } = await db.query('SELECT is_active FROM users WHERE id=$1', [clientId]);

  const { rows: [row] } = await db.query(
    `UPDATE users SET client_noshow_strikes = client_noshow_strikes + 1 WHERE id=$1 RETURNING client_noshow_strikes`,
    [clientId]
  );
  const count = row.client_noshow_strikes;

  await db.query(
    `INSERT INTO client_strikes (client_id, mission_id, reason, created_by) VALUES ($1,$2,$3,$4)`,
    [clientId, missionId, reason, createdBy]
  );

  let justBlocked = false;
  if (count >= 2 && before?.is_active) {
    await db.query(`UPDATE users SET is_active=false WHERE id=$1`, [clientId]);
    justBlocked = true;
  }

  return { count, justBlocked };
}

module.exports = { applyClientStrike };
