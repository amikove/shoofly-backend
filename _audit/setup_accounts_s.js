// Setup des comptes de test pour l'audit "catalogue de scénarios" du 2026-07-18.
// Préfixe 's' (scenario) pour ne pas entrer en collision avec les comptes audit2_* du 2026-07-17.
const { db, api, end } = require('./lib');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const TS = Date.now();
const PASS = 'Test1234!';

async function main() {
  const out = { ts: TS };

  // Admin existant (réutilisé, déjà super_admin) — mint direct d'un JWT valide via JWT_SECRET local.
  const adminId = 'ccaa2f4a-0adf-4d92-b02f-dfa6f9fd1b5b';
  const adminToken = jwt.sign({ id: adminId, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  out.admin = { id: adminId, token: adminToken, email: 'admin@shoofly.ma' };

  // Nouvel admin NON super-admin, pour le scénario 8.3 (insert direct, /register bloque role=admin)
  const { v4: uuidv4 } = require('uuid');
  const bcrypt = require('bcryptjs');
  const nonSaId = uuidv4();
  await db(
    `INSERT INTO users (id,email,password,role,first_name,last_name,is_active,is_super_admin) VALUES ($1,$2,$3,'admin',$4,$5,true,false)`,
    [nonSaId, `s_admin_nonsuper_${TS}@test.local`, bcrypt.hashSync(PASS, 10), 'Admin', 'NonSuper']
  );
  const nonSaToken = jwt.sign({ id: nonSaId, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  out.adminNonSuper = { id: nonSaId, token: nonSaToken, email: `s_admin_nonsuper_${TS}@test.local` };

  // Client
  const clientEmail = `s_client_${TS}@test.local`;
  let r = await api('POST', '/auth/register', {
    email: clientEmail, password: PASS, first_name: 'Client', last_name: 'Scenario',
    role: 'client', phone: `06${String(TS).slice(-8)}`, city: 'Rabat', quartier: 'Agdal',
  });
  if (r.status !== 201) throw new Error('client register failed: ' + JSON.stringify(r));
  out.client = { id: r.data.user.id, token: r.data.token, email: clientEmail };

  // 5 Œils, tous Rabat/Agdal, vérifiés + disponibles (direct DB pour bypass la vérification identité)
  out.oeils = [];
  for (let i = 0; i < 5; i++) {
    const email = `s_oeil${i}_${TS}@test.local`;
    const phone = `07${String(TS).slice(-7)}${i}`;
    r = await api('POST', '/auth/register', {
      email, password: PASS, first_name: `Oeil${i}`, last_name: 'Scenario',
      role: 'oeil', phone, city: 'Rabat', quartier: 'Agdal',
    });
    if (r.status !== 201) throw new Error(`oeil${i} register failed: ` + JSON.stringify(r));
    const oeilId = r.data.user.id;
    await db(`UPDATE oeil_profiles SET is_verified=true, is_available=true WHERE user_id=$1`, [oeilId]);
    await db(`UPDATE users SET is_available=true WHERE id=$1`, [oeilId]);
    out.oeils.push({ id: oeilId, token: r.data.token, email, phone });
  }

  require('fs').writeFileSync(
    require('path').join(__dirname, 'accounts_s.json'),
    JSON.stringify(out, null, 2)
  );
  console.log('OK — comptes créés:', JSON.stringify({ client: out.client.email, oeils: out.oeils.map(o=>o.email), adminNonSuper: out.adminNonSuper.email }, null, 2));
  await end();
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
