const { db, api, end } = require('./lib');
const fs = require('fs');
const path = require('path');
const accounts = require('./accounts_s.json');

const TS = Date.now();
const PASS = 'Test1234!';

async function main() {
  const oeils5 = [];
  for (let i = 0; i < 3; i++) {
    const rand = Math.floor(Math.random() * 9000 + 1000);
    const email = `s5_oeil${i}_${TS}_${rand}@test.local`;
    const phone = `06${String(TS).slice(-6)}${rand}`.slice(0, 10);
    let r = await api('POST', '/auth/register', {
      email, password: PASS, first_name: `S5Oeil${i}`, last_name: 'Scenario',
      role: 'oeil', phone, city: 'Rabat', quartier: 'Agdal',
    });
    if (r.status !== 201) throw new Error(`s5_oeil${i} register failed: ` + JSON.stringify(r));
    const oeilId = r.data.user.id;
    await db(`UPDATE oeil_profiles SET is_verified=true, is_available=true WHERE user_id=$1`, [oeilId]);
    await db(`UPDATE users SET is_available=true WHERE id=$1`, [oeilId]);
    oeils5.push({ id: oeilId, token: r.data.token, email, phone });
  }
  accounts.oeils5 = oeils5;
  fs.writeFileSync(path.join(__dirname, 'accounts_s.json'), JSON.stringify(accounts, null, 2));
  console.log('OK — 3 Œils frais ajoutés (accounts.oeils5)');
  await end();
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
