const { db, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');
const refs = require('./batch_hourly_refs.json');

(async () => {
  const admin = accounts.admin;
  const out = {};

  // ── S7 : client_validation_hours (paiement auto Œil) ──
  {
    const mission = (await db('SELECT validated_at FROM missions WHERE id=$1', [refs.s7.missionId]))[0];
    const balAfter = (await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [refs.s7.oeilId]))[0].balance;
    const wallet = await db(`SELECT * FROM wallet_transactions WHERE mission_id=$1`, [refs.s7.missionId]);
    const expected = parseFloat(refs.s7.oeil_earning);
    out.s7 = {
      validated_at: mission.validated_at,
      balanceBefore: refs.s7.balanceBefore, balanceAfter: balAfter,
      delta: Math.round((parseFloat(balAfter) - parseFloat(refs.s7.balanceBefore)) * 100) / 100,
      expected,
      amount_ok: Math.round((parseFloat(balAfter) - parseFloat(refs.s7.balanceBefore)) * 100) / 100 === expected,
      wallet,
      wallet_ok: wallet.length === 1 && parseFloat(wallet[0].amount) === expected && wallet[0].type === 'credit',
    };
  }

  // ── S13 : stale_mission_hours ──
  {
    const mission = (await db('SELECT stale_notified_at FROM missions WHERE id=$1', [refs.s13.missionId]))[0];
    const notifs = await db(`SELECT title,body,type FROM notifications WHERE mission_id=$1 AND user_id=$2`, [refs.s13.missionId, admin.id]);
    out.s13 = { stale_notified_at: mission.stale_notified_at, notified: mission.stale_notified_at !== null, notifs };
  }

  // ── S14 : mission_overdue_verification_hours ──
  {
    const notifs = await db(`SELECT title,body,type FROM notifications WHERE mission_id=$1 AND user_id=$2`, [refs.s14.missionId, admin.id]);
    out.s14 = { notifs, ok: notifs.length > 0 };
  }

  // ── S15 L1 : alerte seule (pas de transfert, pas de pénalité) ──
  {
    const mission = (await db('SELECT status FROM missions WHERE id=$1', [refs.s15L1.missionId]))[0];
    const notifOeil = await db(`SELECT title FROM notifications WHERE mission_id=$1 AND user_id=$2`, [refs.s15L1.missionId, refs.s15L1.oeilId]);
    const wallet = await db(`SELECT * FROM wallet_transactions WHERE mission_id=$1`, [refs.s15L1.missionId]);
    out.s15L1 = {
      status: mission.status, still_assigned_ok: mission.status === 'assigned',
      notifOeil, alert_sent_ok: notifOeil.some(n => n.title.includes('commencé') || n.title.includes('démarrée')),
      wallet, no_financial_movement_ok: wallet.length === 0,
    };
  }

  // ── S15 L2 : auto-transfert + pénalité -100 ──
  {
    const mission = (await db('SELECT status, is_priority, transfer_type, transferred_from FROM missions WHERE id=$1', [refs.s15L2.missionId]))[0];
    const oeilBalAfter = (await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [refs.s15L2.oeilId]))[0].balance;
    const wallet = await db(`SELECT * FROM wallet_transactions WHERE mission_id=$1 AND user_id=$2`, [refs.s15L2.missionId, refs.s15L2.oeilId]);
    const reliab = await db(`SELECT points, reason, is_grave FROM reliability_events WHERE mission_id=$1 AND oeil_id=$2`, [refs.s15L2.missionId, refs.s15L2.oeilId]);
    const clientBalAfter = (await db('SELECT balance FROM users WHERE id=$1', [accounts.client.id]))[0].balance;
    const expectedOeilBal = Math.round((parseFloat(refs.s15L2.oeil0BalBefore) - 100) * 100) / 100;
    out.s15L2 = {
      status: mission.status, transferred_ok: mission.status === 'pending' && mission.is_priority === true && mission.transfer_type === 'before' && mission.transferred_from === refs.s15L2.oeilId,
      oeilBalBefore: refs.s15L2.oeil0BalBefore, oeilBalAfter, expectedOeilBal,
      penalty_amount_ok: parseFloat(oeilBalAfter) === expectedOeilBal,
      wallet, wallet_ok: wallet.length === 1 && parseFloat(wallet[0].amount) === 100 && wallet[0].type === 'debit',
      reliab, reliab_ok: reliab.length === 1 && reliab[0].points === -20 && reliab[0].is_grave === true,
      clientBalBefore: refs.s15L2.clientBalBeforeL2, clientBalAfter,
      client_no_refund_yet_ok: parseFloat(clientBalAfter) === parseFloat(refs.s15L2.clientBalBeforeL2),
    };
  }

  // ── S16 : reminders early/late ──
  {
    const notifs = await db(`SELECT title FROM notifications WHERE mission_id=$1 AND user_id=$2`, [refs.s16.missionId, refs.s16.oeilId]);
    out.s16 = {
      notifs,
      early_ok: notifs.some(n => n.title.includes('2 heures')),
      late_ok: notifs.some(n => n.title.includes('30 minutes')),
    };
  }

  // ── S19 : ticket_auto_resolve_hours + exclusion is_urgent ──
  {
    const normal = (await db('SELECT status FROM support_tickets WHERE id=$1', [refs.s19.normalTicketId]))[0];
    const urgent = (await db('SELECT status FROM support_tickets WHERE id=$1', [refs.s19.urgentTicketId]))[0];
    const sysMsg = await db(`SELECT content, is_system FROM ticket_messages WHERE ticket_id=$1 AND is_system=true`, [refs.s19.normalTicketId]);
    out.s19 = {
      normal_status: normal.status, normal_resolved_ok: normal.status === 'resolved',
      urgent_status: urgent.status, urgent_excluded_ok: urgent.status === 'in_progress',
      sysMsg,
    };
  }

  console.log(JSON.stringify(out, null, 2));

  // ── Restauration de tous les paramètres du batch ──
  for (const key of ['client_validation_hours','stale_mission_hours','stale_mission_min_lead_hours','mission_overdue_verification_hours','late_start_alert_window_minutes','late_start_auto_transfer_minutes','reminder_before_mission_minutes_early','reminder_before_mission_minutes_late','ticket_auto_resolve_hours']) {
    await resetSetting(key, admin.token);
  }
  console.log('Settings du batch restaurés.');
  await end();
})();
