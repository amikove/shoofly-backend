// Catégorie 6.1 — 3 déclencheurs WhatsApp côté ŒIL : edit_proposed_to_oeil, oeil_hired,
// nouvelle_verification_identite (approbation admin).
const { db, api, end } = require('./lib');
const accounts = require('./accounts_s.json');
const o6 = accounts.oeils6;
const TEST_PHONE = '+212661064492';

function iso(hOffset) { return new Date(Date.now() + hOffset * 3600000).toISOString(); }

async function createMission(price, hOffset, extra = {}) {
  const r = await api('POST', '/missions', {
    type: 'immobilier', title: `Cat6oeil — ${Math.random().toString(36).slice(2, 8)}`, address: '15 rue Chellah',
    city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(hOffset), price, property_type: 'appartement', visit_type: 'physique', ...extra,
  }, accounts.client.token);
  if (r.status !== 201) throw new Error('create mission failed: ' + JSON.stringify(r));
  return r.data.mission;
}

async function main() {
  const results = [];

  // 1) oeil_hired — utilise o6[5], numéro réel posé
  {
    await db(`UPDATE users SET phone=$1 WHERE id=$2`, [TEST_PHONE, o6[5].id]);
    const m = await createMission(300, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, o6[5].token);
    const r = await api('POST', `/missions/${m.id}/hire/${o6[5].id}`, {}, accounts.client.token);
    results.push({ event: 'oeil_hired', trigger: `Client embauche ${o6[5].email} sur ${m.id}`, httpStatus: r.status, ok: r.status === 200 });

    // 2) edit_proposed_to_oeil — réutilise le même Œil (même numéro), mission assignée à l'instant
    const re = await api('PUT', `/missions/${m.id}`, { title: 'Titre modifié — 6.1 propose to oeil' }, accounts.client.token);
    results.push({ event: 'edit_proposed_to_oeil', trigger: `Client propose modification sur ${m.id} (Œil ${o6[5].email})`, httpStatus: re.status, ok: re.status === 202 });
  }

  // 3) nouvelle_verification_identite (approbation) — insertion directe d'un identity_documents pending + approbation admin
  {
    await db(`UPDATE users SET phone=$1 WHERE id=$2`, [TEST_PHONE, o6[0].id]); // déjà utilisé côté client group, phone le déplace ici (unique)
    const { rows: [doc] } = await (async () => {
      const r = await db(`INSERT INTO identity_documents (user_id, cin_recto, cin_verso, selfie, status) VALUES ($1,'test_recto.jpg','test_verso.jpg','test_selfie.jpg','pending') RETURNING id`, [o6[0].id]);
      return { rows: r };
    })();
    const r = await api('POST', `/users/admin/identity-requests/${doc.id}/approve`, {}, accounts.admin.token);
    results.push({ event: 'nouvelle_verification_identite (approbation identité)', trigger: `Admin approuve identité de ${o6[0].email}`, httpStatus: r.status, ok: r.status === 200 });
  }

  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results_cat6_oeil.json'), JSON.stringify(results, null, 2));
  await end();
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
