const { db, api, end } = require('./lib');
const fs = require('fs');
const path = require('path');
const accounts = require('./accounts_s.json');

const TS = Date.now();
const PASS = 'Test1234!';

async function main() {
  const oeils3 = [];
  for (let i = 0; i < 12; i++) {
    const email = `s3_oeil${i}_${TS}@test.local`;
    const phone = `07${String(TS).slice(-7)}${i}`;
    let r = await api('POST', '/auth/register', {
      email, password: PASS, first_name: `S3Oeil${i}`, last_name: 'Scenario',
      role: 'oeil', phone, city: 'Rabat', quartier: 'Agdal',
    });
    if (r.status !== 201) throw new Error(`s3_oeil${i} register failed: ` + JSON.stringify(r));
    const oeilId = r.data.user.id;
    await db(`UPDATE oeil_profiles SET is_verified=true, is_available=true WHERE user_id=$1`, [oeilId]);
    await db(`UPDATE users SET is_available=true WHERE id=$1`, [oeilId]);
    oeils3.push({ id: oeilId, token: r.data.token, email, phone });
  }
  accounts.oeils3 = oeils3;
  fs.writeFileSync(path.join(__dirname, 'accounts_s.json'), JSON.stringify(accounts, null, 2));
  console.log('OK — 12 Œils frais ajoutés (accounts.oeils3)');
  await end();
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
