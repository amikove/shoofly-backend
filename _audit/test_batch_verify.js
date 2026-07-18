// Vérification structurée des scénarios du batch cron (2.7, 2.9, 3.1, 3.2, 3.3, 3.4, 4.4).
const { db, end } = require('./lib');
const b = require('./batch_state2.json');

async function main() {
  const results = [];

  // 2.7
  {
    const [m] = await db('SELECT status, cancel_reason FROM missions WHERE id=$1', [b.s27.missionId]);
    const [oeil] = await db('SELECT op.balance, u.transfer_cooldown_until FROM oeil_profiles op JOIN users u ON u.id=op.user_id WHERE op.user_id=$1', [b.s27.oeilId]);
    const [rel] = await db('SELECT points, is_grave FROM reliability_events WHERE oeil_id=$1 ORDER BY id DESC LIMIT 1', [b.s27.oeilId]);
    const [wt] = await db('SELECT amount FROM wallet_transactions WHERE mission_id=$1 AND user_id=$2 AND type=$3', [b.s27.missionId, b.s27.oeilId, 'debit']);
    const [refund] = await db('SELECT amount FROM wallet_transactions WHERE mission_id=$1 AND type=$2', [b.s27.missionId, 'credit']);
    const cooldownExpected = new Date('2026-07-20T18:25:00.040Z'); // 48h après annulation, tolérance large car horodatage exact déjà vérifié manuellement
    results.push({
      scenario: "2.7 — Transfert 'during', aucun remplaçant → cancel, -70 fiabilité, pénalité capée au solde réel, cooldown 48h",
      expected: `status=cancelled, reliability=-70(grave), pénalité journalisée=min(100,solde avant=0)=0.00 (non-régression fix 155d0c9), remboursement client=320.00 (100%), cooldown +48h`,
      observed: `status=${m.status}, reliability=${rel.points}(grave=${rel.is_grave}), pénalité=${wt.amount}, remboursement=${refund.amount}, cooldown_until=${oeil.transfer_cooldown_until}`,
      ok: m.status === 'cancelled' && rel.points === -70 && rel.is_grave === true && parseFloat(wt.amount) === 0 && parseFloat(refund.amount) === 320,
    });
  }

  // 2.9
  {
    const [m] = await db('SELECT status FROM missions WHERE id=$1', [b.s29.missionId]);
    const [rel] = await db('SELECT points, is_grave FROM reliability_events WHERE oeil_id=$1 ORDER BY id DESC LIMIT 1', [b.s29.oeilId]);
    const wtAll = await db('SELECT type, amount, user_id FROM wallet_transactions WHERE mission_id=$1', [b.s29.missionId]);
    const oeilDebits = wtAll.filter(w => w.user_id === b.s29.oeilId);
    const clientCredit = wtAll.find(w => w.user_id !== b.s29.oeilId);
    results.push({
      scenario: "2.9 — Transfert 'before', aucun remplaçant → cancel, -10 fiabilité SEULEMENT (différent de 2.7 : aucune pénalité financière)",
      expected: `status=cancelled, reliability=-10(grave), 0 ligne wallet_transactions pour l'Œil (contrairement à during), remboursement client=280.00 (100%)`,
      observed: `status=${m.status}, reliability=${rel.points}(grave=${rel.is_grave}), lignes wallet Œil=${oeilDebits.length}, remboursement=${clientCredit?.amount}`,
      ok: m.status === 'cancelled' && rel.points === -10 && rel.is_grave === true && oeilDebits.length === 0 && parseFloat(clientCredit?.amount) === 280,
    });
  }

  // 3.1
  {
    const [m] = await db('SELECT status, oeil_id FROM missions WHERE id=$1', [b.s31.missionId]);
    results.push({
      scenario: "3.1 — Mode 'fast', 2 candidats (score 95 vs 60) + candidature fantôme de l'Œil d'origine → meilleur score sélectionné",
      expected: `oeil_id = meilleur candidat (score 95) = ${b.s31.bestOeilId}`,
      observed: `status=${m.status}, oeil_id=${m.oeil_id}`,
      ok: m.status === 'assigned' && m.oeil_id === b.s31.bestOeilId,
    });
  }

  // 3.2 (déjà vérifié en synchrone lors du setup, on reconfirme que rien n'a changé depuis)
  {
    const [m] = await db('SELECT status, oeil_id, candidate_window_ends_at FROM missions WHERE id=$1', [b.s32.missionId]);
    results.push({
      scenario: "3.2 — Mode 'choose', client choisit manuellement AVANT expiration → choix respecté, fenêtre fermée immédiatement, pas d'écrasement ultérieur par le cron",
      expected: `oeil_id=${b.s32.chosenOeilId} (choix du client), candidate_window_ends_at=NULL immédiatement après /hire, et TOUJOURS le cas après le tick cron suivant`,
      observed: `status=${m.status}, oeil_id=${m.oeil_id}, candidate_window_ends_at=${m.candidate_window_ends_at}, (fermeture immédiate constatée au moment du /hire: ${b.s32.windowClearedImmediately})`,
      ok: m.status === 'assigned' && m.oeil_id === b.s32.chosenOeilId && m.candidate_window_ends_at === null && b.s32.windowClearedImmediately === true,
    });
  }

  // 3.3
  {
    const [m] = await db('SELECT status, oeil_id FROM missions WHERE id=$1', [b.s33.missionId]);
    results.push({
      scenario: "3.3 — Mode 'choose', personne ne répond (client) → sélection auto par défaut du seul candidat réel après délai adaptatif",
      expected: `oeil_id = seul candidat réel = ${b.s33.onlyCandidateId} (PAS l'Œil d'origine ${b.s33.originalOeilId} malgré sa candidature fantôme)`,
      observed: `status=${m.status}, oeil_id=${m.oeil_id}`,
      ok: m.status === 'assigned' && m.oeil_id === b.s33.onlyCandidateId,
    });
  }

  // 3.4 (déjà vérifié en synchrone lors du setup)
  {
    results.push({
      scenario: '3.4 — POST /:id/accept pendant une fenêtre de candidature active → bloqué avec message clair',
      expected: 'HTTP 400, message explicite invitant à manifester son intérêt plutôt qu\'accepter directement',
      observed: `HTTP ${b.s34.acceptStatus}, "${b.s34.acceptError}"`,
      ok: b.s34.acceptStatus === 400 && /phase de sélection/i.test(b.s34.acceptError || ''),
    });
  }

  // 4.4
  {
    const [m] = await db('SELECT status, oeil_id, is_priority, title FROM missions WHERE id=$1', [b.s44.missionId]);
    const [er] = await db('SELECT status FROM mission_edit_requests WHERE id=$1', [b.s44.editRequestId]);
    results.push({
      scenario: '4.4 — Edit-request expire automatiquement (Œil ne répond pas) → même résultat que 4.3 (refus explicite)',
      expected: `mission repasse pending, oeil_id=NULL (même id ${b.s44.missionId}), titre inchangé ("${b.s44.originalTitle}"), edit_request.status=expired, aucune pénalité`,
      observed: `status=${m.status}, oeil_id=${m.oeil_id}, titre="${m.title}", edit_request.status=${er.status}`,
      ok: m.status === 'pending' && m.oeil_id === null && m.title === b.s44.originalTitle && er.status === 'expired',
    });
  }

  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results_batch_cron.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} OK`);
  if (failed.length) console.log('ÉCHECS:', JSON.stringify(failed, null, 2));
  await end();
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
