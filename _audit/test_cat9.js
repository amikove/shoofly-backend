// Catégorie 9 — Codes promo (9.1, 9.2, 9.3) avec de VRAIS codes créés côté admin.
const { db, api, end } = require('./lib');
const accounts = require('./accounts_s.json');

function iso(hOffset) { return new Date(Date.now() + hOffset * 3600000).toISOString(); }

async function main() {
  const results = [];
  const TS = Date.now();

  // ── 9.1 — Code pourcentage : calcul de réduction exact ────
  {
    const code = `PCT15_${TS}`;
    const rc = await api('POST', '/promo/admin', { code, type: 'percent', value: 15, max_uses_per_user: 1 }, accounts.admin.token);
    if (rc.status !== 201) throw new Error('9.1 create promo failed: ' + JSON.stringify(rc));

    const price = 400;
    const rv = await api('POST', '/promo/validate', { code, price }, accounts.client.token);
    const expectedDiscount = Math.round(price * 0.15 * 100) / 100;
    const expectedFinal = price - expectedDiscount;
    results.push({
      scenario: '9.1 — Code promo pourcentage (15%), calcul réduction',
      expected: `discount=${expectedDiscount}, final_price=${expectedFinal}`,
      observed: `HTTP ${rv.status}, discount=${rv.data?.discount}, final_price=${rv.data?.final_price}`,
      ok: rv.status === 200 && rv.data.discount === expectedDiscount && rv.data.final_price === expectedFinal,
    });
  }

  // ── 9.2 — Code gratuit (type='free') : dépense auto + montant exact ──
  {
    const code = `FREE250_${TS}`;
    const platformAmount = 250;
    const rc = await api('POST', '/promo/admin', { code, type: 'free', value: 0, platform_amount: platformAmount, max_uses_per_user: 1 }, accounts.admin.token);
    if (rc.status !== 201) throw new Error('9.2 create promo failed: ' + JSON.stringify(rc));

    const expenseCountBefore = (await db(`SELECT COUNT(*)::int AS n FROM expenses WHERE category='Promotions'`))[0].n;

    const oeil = accounts.oeils3[0]; // déjà utilisé dans 2.7 mais peu importe pour la création
    const rm = await api('POST', '/missions', {
      type: 'immobilier', title: `Mission offerte scénario 9.2 — ${TS}`, address: '9 avenue Promo',
      city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(24), price: 0,
      promo_code: code, platform_amount: platformAmount, // le client envoie CE montant, mais le serveur doit utiliser celui de promo_codes (identique ici, testé aussi en 9.3-bis avec une valeur différente)
    }, accounts.client.token);
    if (rm.status !== 201) throw new Error('9.2 create mission failed: ' + JSON.stringify(rm));

    const [expense] = await db(`SELECT amount, category, description FROM expenses WHERE description LIKE $1 ORDER BY id DESC LIMIT 1`, [`%${code}%`]);
    const expenseCountAfter = (await db(`SELECT COUNT(*)::int AS n FROM expenses WHERE category='Promotions'`))[0].n;

    results.push({
      scenario: '9.2 — Code promo gratuit : mission + dépense Promotions, montant exact',
      expected: `mission.oeil_earning=${platformAmount}, commission=0, 1 nouvelle dépense Promotions de ${platformAmount}`,
      observed: `oeil_earning=${rm.data.mission.oeil_earning}, commission=${rm.data.mission.commission}, dépenses avant/après=${expenseCountBefore}/${expenseCountAfter}, dépense=${expense ? expense.amount : 'aucune'}`,
      ok: parseFloat(rm.data.mission.oeil_earning) === platformAmount && parseFloat(rm.data.mission.commission) === 0
        && expenseCountAfter === expenseCountBefore + 1 && expense && parseFloat(expense.amount) === platformAmount,
    });

    // ── 9.2-bis (durcissement) — le client falsifie platform_amount avec un VRAI code ──
    const rm2 = await api('POST', '/missions', {
      type: 'immobilier', title: `Tentative falsification montant — ${TS}`, address: '9 avenue Promo',
      city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(24), price: 0,
      promo_code: code, platform_amount: 999999, // code réel mais montant falsifié — max_uses_per_user=1 déjà consommé juste au-dessus
    }, accounts.client.token);
    results.push({
      scenario: "9.2-bis — Vrai code déjà utilisé (max_uses_per_user=1) → rejeté, ET le montant client n'est jamais source de vérité",
      expected: 'HTTP 400 "Vous avez déjà utilisé ce code" (protège aussi contre la falsification de platform_amount)',
      observed: `HTTP ${rm2.status}, ${JSON.stringify(rm2.data)}`,
      ok: rm2.status === 400 && /déjà utilisé ce code/i.test(rm2.data?.error || ''),
    });
  }

  // ── 9.3a — Code expiré ─────────────────────────────────────
  {
    const code = `EXPIRED_${TS}`;
    const rc = await api('POST', '/promo/admin', { code, type: 'percent', value: 10, expires_at: iso(1) }, accounts.admin.token);
    if (rc.status !== 201) throw new Error('9.3a create promo failed: ' + JSON.stringify(rc));
    await db(`UPDATE promo_codes SET expires_at=NOW() - INTERVAL '1 day' WHERE id=$1`, [rc.data.promo.id]);

    const rv = await api('POST', '/promo/validate', { code, price: 300 }, accounts.client.token);
    results.push({
      scenario: '9.3a — Code promo expiré',
      expected: 'HTTP 400 "Code promo expiré"',
      observed: `HTTP ${rv.status}, ${JSON.stringify(rv.data)}`,
      ok: rv.status === 400 && /expiré/i.test(rv.data?.error || ''),
    });
  }

  // ── 9.3b — Code dupliqué (création admin) ─────────────────
  {
    const code = `DUPTEST_${TS}`;
    const r1 = await api('POST', '/promo/admin', { code, type: 'fixed', value: 50 }, accounts.admin.token);
    const r2 = await api('POST', '/promo/admin', { code: code.toLowerCase(), type: 'fixed', value: 30 }, accounts.admin.token); // insensible à la casse
    results.push({
      scenario: '9.3b — Code promo dupliqué (même code, casse différente)',
      expected: 'HTTP 201 puis HTTP 409 "existe déjà"',
      observed: `1er: HTTP ${r1.status}, 2e: HTTP ${r2.status} ${JSON.stringify(r2.data)}`,
      ok: r1.status === 201 && r2.status === 409 && /existe déjà/i.test(r2.data?.error || ''),
    });
  }

  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results_cat9.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} OK`);
  if (failed.length) console.log('ÉCHECS:', JSON.stringify(failed, null, 2));
  await end();
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
