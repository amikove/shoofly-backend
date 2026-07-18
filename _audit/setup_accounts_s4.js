const { db, api, end } = require('./lib');
const fs = require('fs');
const path = require('path');
const accounts = require('./accounts_s.json');

const TS = Date.now();
const PASS = 'Test1234!';

async function main() {
  const oeils4 = [];
  for (let i = 0; i < 6; i++) {
    const email = `s4_oeil${i}_${TS}@test.local`;
    const phone = `05${String(TS).slice(-8)}${i}`;
    let r = await api('POST', '/auth/register', {
      email, password: PASS, first_name: `S4Oeil${i}`, last_name: 'Scenario',
      role: 'oeil', phone, city: 'Rabat', quartier: 'Agdal',
    });
    if (r.status !== 201) throw new Error(`s4_oeil${i} register failed: ` + JSON.stringify(r));
    const oeilId = r.data.user.id;
    await db(`UPDATE oeil_profiles SET is_verified=true, is_available=true WHERE user_id=$1`, [oeilId]);
    await db(`UPDATE users SET is_available=true WHERE id=$1`, [oeilId]);
    oeils4.push({ id: oeilId, token: r.data.token, email, phone });
  }
  accounts.oeils4 = oeils4;
  fs.writeFileSync(path.join(__dirname, 'accounts_s.json'), JSON.stringify(accounts, null, 2));
  console.log('OK — 6 Œils frais ajoutés (accounts.oeils4)');
  await end();
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
