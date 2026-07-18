// Catégorie 6.1 — 5 déclencheurs WhatsApp côté CLIENT : oeil_applied, edit_request_approved,
// edit_request_rejected, edit_request_expired, mission_completed_client.
const { db, api, setSetting, end } = require('./lib');
const accounts = require('./accounts_s.json');
const o6 = accounts.oeils6;
const TEST_PHONE = '+212661064492';

function iso(hOffset) { return new Date(Date.now() + hOffset * 3600000).toISOString(); }

async function createMission(price, hOffset, extra = {}) {
  const r = await api('POST', '/missions', {
    type: 'immobilier', title: `Cat6 — ${Math.random().toString(36).slice(2, 8)}`, address: '11 rue Oued Zem',
    city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(hOffset), price, property_type: 'appartement', visit_type: 'physique', ...extra,
  }, accounts.client.token);
  if (r.status !== 201) throw new Error('create mission failed: ' + JSON.stringify(r));
  return r.data.mission;
}

async function main() {
  const results = [];

  // Le client reçoit les 5 notifications de ce groupe — un seul numéro à poser.
  await db(`UPDATE users SET phone=$1 WHERE id=$2`, [TEST_PHONE, accounts.client.id]);
  console.log(`Téléphone client réglé sur ${TEST_PHONE}`);

  // 1) oeil_applied — un Œil manifeste son intérêt sur une mission pending
  {
    const m = await createMission(300, 24);
    const r = await api('POST', `/missions/${m.id}/interest`, {}, o6[0].token);
    results.push({ event: 'oeil_applied', trigger: `Œil ${o6[0].email} postule sur mission ${m.id}`, httpStatus: r.status, ok: r.status === 201 });
  }

  // 2) edit_request_approved — Œil approuve une modification proposée
  {
    const m = await createMission(300, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, o6[1].token);
    await api('POST', `/missions/${m.id}/hire/${o6[1].id}`, {}, accounts.client.token);
    const re = await api('PUT', `/missions/${m.id}`, { title: 'Titre modifié — 6.1 approve' }, accounts.client.token);
    const ra = await api('POST', `/missions/edit-requests/${re.data.edit_request.id}/approve`, {}, o6[1].token);
    results.push({ event: 'edit_request_approved', trigger: `Œil ${o6[1].email} approuve la modification sur ${m.id}`, httpStatus: ra.status, ok: ra.status === 200 });
  }

  // 3) edit_request_rejected — Œil refuse une modification proposée
  {
    const m = await createMission(300, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, o6[2].token);
    await api('POST', `/missions/${m.id}/hire/${o6[2].id}`, {}, accounts.client.token);
    const re = await api('PUT', `/missions/${m.id}`, { title: 'Titre modifié — 6.1 reject' }, accounts.client.token);
    const rr = await api('POST', `/missions/edit-requests/${re.data.edit_request.id}/reject`, {}, o6[2].token);
    results.push({ event: 'edit_request_rejected', trigger: `Œil ${o6[2].email} refuse la modification sur ${m.id}`, httpStatus: rr.status, ok: rr.status === 200 });
  }

  // 4) mission_completed_client — Œil marque la mission terminée
  {
    const m = await createMission(300, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, o6[3].token);
    await api('POST', `/missions/${m.id}/hire/${o6[3].id}`, {}, accounts.client.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'en_route' }, o6[3].token);
    await api('POST', `/missions/${m.id}/status`, { status: 'active' }, o6[3].token);
    const rc = await api('POST', `/missions/${m.id}/status`, { status: 'completed' }, o6[3].token);
    results.push({ event: 'mission_completed_client', trigger: `Œil ${o6[3].email} termine la mission ${m.id}`, httpStatus: rc.status, ok: rc.status === 200 });
  }

  // 5) edit_request_expired — expiration automatique (cron */5min)
  {
    await setSetting('mission_edit_approval_minutes', '0.05', accounts.admin.token); // ~3s
    const m = await createMission(300, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, o6[4].token);
    await api('POST', `/missions/${m.id}/hire/${o6[4].id}`, {}, accounts.client.token);
    const re = await api('PUT', `/missions/${m.id}`, { title: 'Titre modifié — 6.1 expire' }, accounts.client.token);
    results.push({ event: 'edit_request_expired', trigger: `edit_request ${re.data.edit_request.id} sur ${m.id} (attente cron */5min)`, httpStatus: re.status, ok: re.status === 202, pending: true, editRequestId: re.data.edit_request.id, missionId: m.id });
  }

  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results_cat6_client.json'), JSON.stringify(results, null, 2));
  await end();
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
