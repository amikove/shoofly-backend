// Catégorie 8 — Anti-fraude et sécurité (8.1, 8.2, 8.3).
const { api, end } = require('./lib');
const accounts = require('./accounts_s.json');

function iso(hOffset) { return new Date(Date.now() + hOffset * 3600000).toISOString(); }

async function main() {
  const results = [];
  const TS = Date.now();

  // ── 8.1a — ville invalide (appel direct, contournant le frontend) ────────
  {
    const r = await api('POST', '/missions', {
      type: 'immobilier', title: 'Test ville invalide scénario 8.1', address: '1 rue Test',
      city: 'VilleImaginaireXYZ', scheduled_at: iso(24), price: 200,
    }, accounts.client.token);
    results.push({
      scenario: '8.1a — Création mission avec ville invalide (API directe)',
      expected: 'HTTP 400 "Ville invalide"',
      observed: `HTTP ${r.status}, ${JSON.stringify(r.data)}`,
      ok: r.status === 400 && /ville invalide/i.test(r.data?.error || ''),
    });
  }
  // ── 8.1b — sous-catégorie invalide ────────────────────────
  {
    const r = await api('POST', '/missions', {
      type: 'immobilier', title: 'Test sous-catégorie invalide 8.1', address: '1 rue Test',
      city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(24), price: 200, subcategory: 'SousCategorieBidonXYZ',
    }, accounts.client.token);
    results.push({
      scenario: '8.1b — Création mission avec sous-catégorie invalide (API directe)',
      expected: 'HTTP 400 "Sous-catégorie invalide..."',
      observed: `HTTP ${r.status}, ${JSON.stringify(r.data)}`,
      ok: r.status === 400 && /sous-catégorie invalide/i.test(r.data?.error || ''),
    });
  }

  // ── 8.2a — doublon email à l'inscription ──────────────────
  {
    const email = `s_dup_${TS}@test.local`;
    const r1 = await api('POST', '/auth/register', { email, password: 'Test1234!', first_name: 'Dup', last_name: 'Test', role: 'client', phone: `0611${TS}`.slice(0, 10) });
    const r2 = await api('POST', '/auth/register', { email, password: 'Test1234!', first_name: 'Dup2', last_name: 'Test2', role: 'client', phone: `0622${TS}`.slice(0, 10) });
    results.push({
      scenario: '8.2a — Doublon email à l\'inscription',
      expected: 'HTTP 201 puis HTTP 409 "Email déjà utilisé"',
      observed: `1er: HTTP ${r1.status}, 2e: HTTP ${r2.status} ${JSON.stringify(r2.data)}`,
      ok: r1.status === 201 && r2.status === 409 && /email déjà utilisé/i.test(r2.data?.error || ''),
    });
  }
  // ── 8.2b — doublon téléphone à l'inscription ──────────────
  {
    const phone = `0699${String(TS).slice(-6)}`;
    const r1 = await api('POST', '/auth/register', { email: `s_dupphone1_${TS}@test.local`, password: 'Test1234!', first_name: 'DupPhone', last_name: 'Test', role: 'client', phone });
    const r2 = await api('POST', '/auth/register', { email: `s_dupphone2_${TS}@test.local`, password: 'Test1234!', first_name: 'DupPhone2', last_name: 'Test2', role: 'client', phone });
    results.push({
      scenario: '8.2b — Doublon téléphone à l\'inscription',
      expected: 'HTTP 201 puis HTTP 409 "Numéro de téléphone déjà utilisé"',
      observed: `1er: HTTP ${r1.status}, 2e: HTTP ${r2.status} ${JSON.stringify(r2.data)}`,
      ok: r1.status === 201 && r2.status === 409 && /téléphone déjà utilisé/i.test(r2.data?.error || ''),
    });
  }
  // ── 8.2c — doublon téléphone en modification de profil ───
  {
    const phoneA = `0688${String(TS).slice(-6)}`;
    const phoneB = `0677${String(TS).slice(-6)}`;
    const ra = await api('POST', '/auth/register', { email: `s_dupmod_a_${TS}@test.local`, password: 'Test1234!', first_name: 'ModA', last_name: 'Test', role: 'client', phone: phoneA });
    const rb = await api('POST', '/auth/register', { email: `s_dupmod_b_${TS}@test.local`, password: 'Test1234!', first_name: 'ModB', last_name: 'Test', role: 'client', phone: phoneB });
    const rMod = await api('PUT', '/auth/me', { phone: phoneA }, rb.data.token); // B tente de prendre le téléphone de A
    results.push({
      scenario: '8.2c — Doublon téléphone en modification de profil',
      expected: 'HTTP 409 "Numéro de téléphone déjà utilisé"',
      observed: `HTTP ${rMod.status}, ${JSON.stringify(rMod.data)}`,
      ok: rMod.status === 409 && /téléphone déjà utilisé/i.test(rMod.data?.error || ''),
    });
  }
  // Note : l'email n'est modifiable par AUCUNE route (PUT /auth/me ne l'accepte pas) — le doublon
  // email n'est donc vérifiable qu'à l'inscription (8.2a), pas en modification de profil.

  // ── 8.3 — admin non-superAdmin tente de désactiver un autre admin ────────
  {
    const target = accounts.admin; // admin@shoofly.ma, super_admin
    const r = await api('PUT', `/users/admin/${target.id}/toggle-active`, {}, accounts.adminNonSuper.token);
    results.push({
      scenario: '8.3 — Admin non-superAdmin tente de désactiver un compte admin',
      expected: 'HTTP 403 "Seul le Super Admin peut activer/désactiver un compte administrateur."',
      observed: `HTTP ${r.status}, ${JSON.stringify(r.data)}`,
      ok: r.status === 403 && /seul le super admin/i.test(r.data?.error || ''),
    });
  }

  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results_cat8.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} OK`);
  if (failed.length) console.log('ÉCHECS:', JSON.stringify(failed, null, 2));
  await end();
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
