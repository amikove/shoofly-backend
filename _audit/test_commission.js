// Scénario 9 — Vérification COMMISSION pure sur 3 prix différents.
const { db, api, end } = require('./lib');
const accounts = require('./accounts.json');

(async () => {
  const client = accounts.client;
  const prices = [100, 250, 500];
  const results = [];

  const { rows: [{ value: rateStr }] } = { rows: await db("SELECT value FROM settings WHERE key='commission'") };
  const rate = parseFloat(rateStr);
  console.log('Taux de commission actuel des settings:', rate);

  for (const price of prices) {
    const r = await api('POST', '/missions', {
      type: 'personnalisee', title: `Audit commission test ${price}MAD`, address: '12 rue Test', city: 'Casablanca',
      scheduled_at: new Date(Date.now() + 3 * 3600 * 1000).toISOString(), price,
    }, client.token);
    if (r.status !== 201) { console.error('CREATE FAIL', price, r); continue; }
    const m = r.data.mission;
    const expectedCommission = Math.round(price * rate * 100) / 100;
    const expectedEarning = Math.round((price - expectedCommission) * 100) / 100;
    const actualCommission = parseFloat(m.commission);
    const actualEarning = parseFloat(m.oeil_earning);
    const ok = actualCommission === expectedCommission && actualEarning === expectedEarning;
    results.push({ price, expectedCommission, actualCommission, expectedEarning, actualEarning, ok, mission_id: m.id });
  }
  console.log(JSON.stringify(results, null, 2));
  await end();
})();
