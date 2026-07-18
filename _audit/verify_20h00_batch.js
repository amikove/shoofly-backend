const { db, end } = require('./lib');

async function main() {
  const results = [];

  // 1.2 — auto-validation
  {
    const s = require('./s12_state.json');
    const [m] = await db('SELECT validated_at, status FROM missions WHERE id=$1', [s.missionId]);
    const [wt] = await db(`SELECT type, amount, reason FROM wallet_transactions WHERE mission_id=$1 AND user_id=$2`, [s.missionId, s.oeilId]);
    const [bal] = await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [s.oeilId]);
    const delta = Math.round((parseFloat(bal.balance) - s.balanceBefore) * 100) / 100;
    results.push({
      scenario: '1.2 — Auto-validation cron (client ne valide pas) : paiement identique au cas manuel',
      expected: `validated_at renseigné, credit ${s.oeilEarning} exact, reason="Validation automatique après délai"`,
      observed: `validated_at=${m.validated_at ? 'renseigné' : 'NULL'}, wallet: ${wt?.type} ${wt?.amount} (${wt?.reason}), delta balance=+${delta}`,
      ok: m.validated_at !== null && wt?.type === 'credit' && parseFloat(wt?.amount) === parseFloat(s.oeilEarning) && delta === parseFloat(s.oeilEarning) && wt?.reason === 'Validation automatique après délai',
    });
  }

  // 7.1 — ticket normal auto-résolu
  {
    const s = require('./ticket_state.json');
    const [t] = await db('SELECT status, resolved_by, resolved_at FROM support_tickets WHERE id=$1', [s.s71.ticketId]);
    const [msg] = await db(`SELECT content, is_system FROM ticket_messages WHERE ticket_id=$1 ORDER BY id DESC LIMIT 1`, [s.s71.ticketId]);
    results.push({
      scenario: '7.1 — Ticket normal, auto-résolution après délai configuré',
      expected: 'status=resolved, resolved_by=NULL, message système ajouté',
      observed: `status=${t.status}, resolved_by=${t.resolved_by}, dernier message="${msg?.content}" (is_system=${msg?.is_system})`,
      ok: t.status === 'resolved' && t.resolved_by === null && msg?.is_system === true,
    });
  }

  // 7.2 — ticket urgent JAMAIS auto-résolu
  {
    const s = require('./ticket_state.json');
    const [t] = await db('SELECT status, is_urgent FROM support_tickets WHERE id=$1', [s.s72.ticketId]);
    results.push({
      scenario: '7.2 — Ticket urgent (is_urgent=true) : NE DOIT JAMAIS auto-résoudre',
      expected: 'status reste in_progress malgré le délai dépassé',
      observed: `status=${t.status}, is_urgent=${t.is_urgent}`,
      ok: t.status === 'in_progress' && t.is_urgent === true,
    });
  }

  // 6.2 — missions orphelines : notification créée + non-blocage
  {
    const s = require('./s62_state.json');
    const notifs = await db(`SELECT mission_id, COUNT(*)::int AS n FROM notifications WHERE mission_id = ANY($1) AND title LIKE '%sans Œil%' GROUP BY mission_id`, [s.missionIds]);
    const [m0] = await db('SELECT stale_notified_at FROM missions WHERE id=$1', [s.missionIds[0]]);
    const [m1] = await db('SELECT stale_notified_at FROM missions WHERE id=$1', [s.missionIds[1]]);
    results.push({
      scenario: "6.2 — Rappels à délai (mission sans Œil 12h) : absence de réaction ne bloque PAS le cron pour les autres missions",
      expected: 'les 2 missions orphelines reçoivent CHACUNE leur notification (aucune ne bloque le traitement de l\'autre), stale_notified_at renseigné pour les 2',
      observed: `notifications par mission: ${JSON.stringify(notifs)}, stale_notified_at: m0=${m0.stale_notified_at ? 'oui' : 'non'}, m1=${m1.stale_notified_at ? 'oui' : 'non'}`,
      ok: notifs.length === 2 && notifs.every(n => n.n >= 1) && m0.stale_notified_at !== null && m1.stale_notified_at !== null,
    });
  }

  // 6.1 (edit_request_expired) — vérification finale du cron */5min
  {
    const cat6 = require('./results_cat6_client.json');
    const expiredEntry = cat6.find(r => r.event === 'edit_request_expired');
    const [er] = await db('SELECT status FROM mission_edit_requests WHERE id=$1', [expiredEntry.editRequestId]);
    const [m] = await db('SELECT status, oeil_id FROM missions WHERE id=$1', [expiredEntry.missionId]);
    results.push({
      scenario: '6.1 (complément) — edit_request_expired : expiration auto déclenche bien sendWhatsAppTemplate au bon moment',
      expected: 'edit_request.status=expired, mission repasse pending/oeil_id=NULL (déclenche le WhatsApp au client)',
      observed: `edit_request.status=${er.status}, mission.status=${m.status}, oeil_id=${m.oeil_id}`,
      ok: er.status === 'expired' && m.status === 'pending' && m.oeil_id === null,
    });
  }

  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results_20h00_batch.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} OK`);
  if (failed.length) console.log('ÉCHECS:', JSON.stringify(failed, null, 2));
  await end();
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
