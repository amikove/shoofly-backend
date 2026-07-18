// Scénarios 8, 10, 11 — Annulations client/oeil/admin à différents délais, avec vérification EXACTE des montants.
const { db, api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');

async function createAndAssign(price, hoursAhead, oeilToken, oeilId) {
  const c = await api('POST', '/missions', {
    type: 'personnalisee', title: `Audit cancel test ${price}MAD h${hoursAhead}`, address: '12 rue Test', city: 'Casablanca',
    scheduled_at: new Date(Date.now() + hoursAhead * 3600 * 1000).toISOString(), price,
  }, accounts.client.token);
  if (c.status !== 201) throw new Error('create fail ' + JSON.stringify(c));
  const mission = c.data.mission;

  if (oeilToken) {
    const interest = await api('POST', `/missions/${mission.id}/interest`, { message: 'test' }, oeilToken);
    if (interest.status !== 201) throw new Error('interest fail ' + JSON.stringify(interest));
    const hire = await api('POST', `/missions/${mission.id}/hire/${oeilId}`, {}, accounts.client.token);
    if (hire.status !== 200) throw new Error('hire fail ' + JSON.stringify(hire));
    return hire.data.mission;
  }
  return mission;
}

async function getBalance(userId) {
  const rows = await db('SELECT balance FROM users WHERE id=$1', [userId]);
  return parseFloat(rows[0].balance);
}

async function getWalletLines(userId, missionId) {
  return db(`SELECT type,amount,reason,mission_id FROM wallet_transactions WHERE user_id=$1 AND mission_id=$2 ORDER BY id`, [userId, missionId]);
}

async function cancelAs(missionId, token, extraBody = {}) {
  return api('POST', `/missions/${missionId}/status`, { status: 'cancelled', cancel_reason: 'audit test', ...extraBody }, token);
}

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;
  const oeil0 = accounts.oeils[0];
  const results = [];

  // ── 10a. Avant assignation → 100% ──────────────────────────
  {
    const price = 300;
    const before = await getBalance(client.id);
    const m = await createAndAssign(price, 5, null, null); // pas d'oeil
    const r = await cancelAs(m.id, client.token);
    const after = await getBalance(client.id);
    const lines = await getWalletLines(client.id, m.id);
    const expected = price;
    results.push({
      scenario: '10a client cancel AVANT assignation',
      price, expectedRefund: expected,
      status: r.status,
      balanceBefore: before, balanceAfter: after, delta: Math.round((after - before) * 100) / 100,
      wallet_lines: lines,
      ok: r.status === 200 && Math.round((after - before) * 100) / 100 === expected && lines.length === 1 && lines[0].type === 'credit' && parseFloat(lines[0].amount) === expected,
    });
  }

  // ── 10b. >2h avant, assignée, taux par défaut 0.5 ──────────
  {
    const price = 300;
    const before = await getBalance(client.id);
    const m = await createAndAssign(price, 5, oeil0.token, oeil0.id); // 5h ahead, >2h threshold
    const r = await cancelAs(m.id, client.token);
    const after = await getBalance(client.id);
    const lines = await getWalletLines(client.id, m.id);
    const expected = Math.round(price * 0.5 * 100) / 100;
    results.push({
      scenario: '10b client cancel >2h avant (taux défaut 0.5)',
      price, expectedRefund: expected,
      status: r.status,
      balanceBefore: before, balanceAfter: after, delta: Math.round((after - before) * 100) / 100,
      wallet_lines: lines,
      ok: r.status === 200 && Math.round((after - before) * 100) / 100 === expected && lines.length === 1 && lines[0].type === 'credit' && parseFloat(lines[0].amount) === expected,
    });
  }

  // ── 10c. <2h avant, assignée → 0% ───────────────────────────
  {
    const price = 300;
    const before = await getBalance(client.id);
    const m = await createAndAssign(price, 1, oeil0.token, oeil0.id); // 1h ahead, <2h threshold
    const r = await cancelAs(m.id, client.token);
    const after = await getBalance(client.id);
    const lines = await getWalletLines(client.id, m.id);
    const expected = 0;
    results.push({
      scenario: '10c client cancel <2h avant (0%)',
      price, expectedRefund: expected,
      status: r.status,
      balanceBefore: before, balanceAfter: after, delta: Math.round((after - before) * 100) / 100,
      wallet_lines: lines,
      ok: r.status === 200 && Math.round((after - before) * 100) / 100 === expected && lines.length === 0,
    });
  }

  // ── 8. refund_partial_rate=0.75, >2h avant, assignée ────────
  {
    await setSetting('refund_partial_rate', '0.75', admin.token);
    const price = 400;
    const before = await getBalance(client.id);
    const m = await createAndAssign(price, 5, oeil0.token, oeil0.id);
    const r = await cancelAs(m.id, client.token);
    const after = await getBalance(client.id);
    const lines = await getWalletLines(client.id, m.id);
    const expected = Math.round(price * 0.75 * 100) / 100;
    results.push({
      scenario: '8 refund_partial_rate=0.75, >2h avant',
      price, expectedRefund: expected,
      status: r.status,
      balanceBefore: before, balanceAfter: after, delta: Math.round((after - before) * 100) / 100,
      wallet_lines: lines,
      ok: r.status === 200 && Math.round((after - before) * 100) / 100 === expected && lines.length === 1 && lines[0].type === 'credit' && parseFloat(lines[0].amount) === expected,
    });
    await resetSetting('refund_partial_rate', admin.token);
  }

  // ── 11a. Annulation par l'Œil, <2h avant → 100% quand même ──
  {
    const price = 350;
    const before = await getBalance(client.id);
    const m = await createAndAssign(price, 1, accounts.oeils[1].token, accounts.oeils[1].id); // <2h, mais oeil annule
    const r = await cancelAs(m.id, accounts.oeils[1].token);
    const after = await getBalance(client.id);
    const lines = await getWalletLines(client.id, m.id);
    const expected = price;
    results.push({
      scenario: '11a annulation par Œil <2h avant (doit être 100% quand même)',
      price, expectedRefund: expected,
      status: r.status,
      balanceBefore: before, balanceAfter: after, delta: Math.round((after - before) * 100) / 100,
      wallet_lines: lines,
      ok: r.status === 200 && Math.round((after - before) * 100) / 100 === expected && lines.length === 1 && lines[0].type === 'credit' && parseFloat(lines[0].amount) === expected,
    });
  }

  // ── 11b. Annulation par admin (non imputable au client), <2h avant → 100% ──
  {
    const price = 350;
    const before = await getBalance(client.id);
    const m = await createAndAssign(price, 1, accounts.oeils[2].token, accounts.oeils[2].id);
    const r = await cancelAs(m.id, admin.token, {}); // pas de client_at_fault
    const after = await getBalance(client.id);
    const lines = await getWalletLines(client.id, m.id);
    const expected = price;
    results.push({
      scenario: '11b annulation par admin (non imputable client) <2h avant → 100%',
      price, expectedRefund: expected,
      status: r.status,
      balanceBefore: before, balanceAfter: after, delta: Math.round((after - before) * 100) / 100,
      wallet_lines: lines,
      ok: r.status === 200 && Math.round((after - before) * 100) / 100 === expected && lines.length === 1 && lines[0].type === 'credit' && parseFloat(lines[0].amount) === expected,
    });
  }

  console.log(JSON.stringify(results, null, 2));
  await end();
})();
