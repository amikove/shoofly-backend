// Crée les comptes de test dédiés à cet audit (client + 3 oeils) et affiche leurs identifiants + JWT.
require('dotenv').config();
const BASE = 'http://127.0.0.1:3001/api';

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

(async () => {
  const ts = Date.now();
  const out = {};

  // Admin login
  const adminLogin = await api('POST', '/auth/login', { email: 'admin@shoofly.ma', password: 'admin123' });
  if (adminLogin.status !== 200) { console.error('ADMIN LOGIN FAIL', adminLogin); process.exit(1); }
  out.admin = { token: adminLogin.data.token, id: adminLogin.data.user.id };

  // Client
  const clientEmail = `audit2_client_${ts}@test.local`;
  const clientReg = await api('POST', '/auth/register', {
    email: clientEmail, password: 'Test1234!', first_name: 'AuditClient', last_name: 'Test', role: 'client', city: 'Casablanca',
  });
  if (clientReg.status !== 201) { console.error('CLIENT REG FAIL', clientReg); process.exit(1); }
  const clientLogin = await api('POST', '/auth/login', { email: clientEmail, password: 'Test1234!' });
  out.client = { email: clientEmail, token: clientLogin.data.token, id: clientLogin.data.user.id };

  // 3 Oeils
  out.oeils = [];
  for (let i = 0; i < 3; i++) {
    const email = `audit2_oeil${i}_${ts}@test.local`;
    const reg = await api('POST', '/auth/register', {
      email, password: 'Test1234!', first_name: `AuditOeil${i}`, last_name: 'Test', role: 'oeil', city: 'Casablanca',
    });
    if (reg.status !== 201) { console.error('OEIL REG FAIL', reg); process.exit(1); }
    const login = await api('POST', '/auth/login', { email, password: 'Test1234!' });
    out.oeils.push({ email, token: login.data.token, id: login.data.user.id });
  }

  console.log(JSON.stringify(out, null, 2));
})();
