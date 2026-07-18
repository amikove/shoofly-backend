// Reprise propre du batch (2.7, 2.9, 3.1, 3.2, 3.3, 3.4, 4.4) après correctif du bug
// d'auto-réassignation (mission_interests non nettoyée à /transfer). Oeils3 = 100% frais.
// Chaque appel HTTP critique est vérifié explicitement (le batch précédent a échoué
// silencieusement sur un cooldown résiduel faute de ces vérifications).
const { db, api, end, setSetting } = require('./lib');
const accounts = require('./accounts_s.json');

function iso(hOffset) { return new Date(Date.now() + hOffset * 3600000).toISOString(); }
const o3 = accounts.oeils3;

function assert(cond, msg, payload) {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(payload)}`);
}

async function createMission(price, hOffset, extra = {}) {
  const r = await api('POST', '/missions', {
    type: 'immobilier', title: `Batch2 — ${Math.random().toString(36).slice(2, 8)}`, address: '3 rue Al Massira',
    city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(hOffset), price, property_type: 'appartement', visit_type: 'physique', ...extra,
  }, accounts.client.token);
  assert(r.status === 201, 'create mission failed', r);
  return r.data.mission;
}

async function interestAndHire(missionId, oeil) {
  let r = await api('POST', `/missions/${missionId}/interest`, {}, oeil.token);
  assert(r.status === 201, `interest failed (${oeil.email})`, r);
  r = await api('POST', `/missions/${missionId}/hire/${oeil.id}`, {}, accounts.client.token);
  assert(r.status === 200, `hire failed (${oeil.email})`, r);
  return r.data.mission;
}

async function main() {
  const state = {};

  // ── 2.7 — during, aucun remplaçant ────────────────────────
  {
    const m = await createMission(320, 24);
    await interestAndHire(m.id, o3[0]);
    let r = await api('POST', `/missions/${m.id}/status`, { status: 'en_route' }, o3[0].token);
    assert(r.status === 200, '2.7 en_route failed', r);
    r = await api('POST', `/missions/${m.id}/status`, { status: 'active' }, o3[0].token);
    assert(r.status === 200, '2.7 active failed', r);
    r = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement (2.7)' }, o3[0].token);
    assert(r.status === 200 && r.data.transfer_type === 'during', '2.7 transfer failed', r);
    state.s27 = { missionId: m.id, oeilId: o3[0].id, price: 320, balanceBefore: parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [o3[0].id]))[0].balance) };
  }

  // ── 2.9 — before, aucun remplaçant ────────────────────────
  {
    const m = await createMission(280, 24);
    await interestAndHire(m.id, o3[1]);
    const r = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement (2.9)' }, o3[1].token);
    assert(r.status === 200 && r.data.transfer_type === 'before', '2.9 transfer failed', r);
    state.s29 = { missionId: m.id, oeilId: o3[1].id, price: 280, balanceBefore: parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [o3[1].id]))[0].balance) };
  }

  // ── 3.1 — fast, 2 candidats score différent ───────────────
  {
    const m = await createMission(300, 24);
    await interestAndHire(m.id, o3[2]);
    const r = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement (3.1)' }, o3[2].token);
    assert(r.status === 200, '3.1 transfer failed', r);
    await db(`UPDATE users SET reliability_score=95 WHERE id=$1`, [o3[3].id]);
    await db(`UPDATE users SET reliability_score=60 WHERE id=$1`, [o3[4].id]);
    let ri = await api('POST', `/missions/${m.id}/interest`, {}, o3[4].token);
    assert(ri.status === 201, '3.1 interest o3[4] failed', ri);
    ri = await api('POST', `/missions/${m.id}/interest`, {}, o3[3].token);
    assert(ri.status === 201, '3.1 interest o3[3] failed', ri);
    state.s31 = { missionId: m.id, bestOeilId: o3[3].id, worstOeilId: o3[4].id, originalOeilId: o3[2].id };
  }

  // ── 3.2 — choose, client choisit manuellement AVANT expiration ──
  {
    const m = await createMission(300, 24, { replacement_preference: 'choose' });
    await interestAndHire(m.id, o3[5]);
    const rt = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement (3.2)' }, o3[5].token);
    assert(rt.status === 200, '3.2 transfer failed', rt);
    const ri = await api('POST', `/missions/${m.id}/interest`, {}, o3[6].token);
    assert(ri.status === 201, '3.2 interest failed', ri);
    const rh = await api('POST', `/missions/${m.id}/hire/${o3[6].id}`, {}, accounts.client.token);
    assert(rh.status === 200, '3.2 hire manuel failed', rh);
    state.s32 = { missionId: m.id, chosenOeilId: o3[6].id, statusAfterHire: rh.data.mission.status, windowClearedImmediately: rh.data.mission.candidate_window_ends_at === null };
  }

  // ── 3.3 — choose, personne ne répond ──────────────────────
  {
    const m = await createMission(300, 24, { replacement_preference: 'choose' });
    await interestAndHire(m.id, o3[7]);
    const rt = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement (3.3)' }, o3[7].token);
    assert(rt.status === 200, '3.3 transfer failed', rt);
    const ri = await api('POST', `/missions/${m.id}/interest`, {}, o3[8].token);
    assert(ri.status === 201, '3.3 interest failed', ri);
    state.s33 = { missionId: m.id, onlyCandidateId: o3[8].id, originalOeilId: o3[7].id };
  }

  // ── 3.4 — POST /accept pendant fenêtre active → bloqué ────
  {
    const m = await createMission(300, 24);
    await interestAndHire(m.id, o3[9]);
    const rt = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement (3.4)' }, o3[9].token);
    assert(rt.status === 200, '3.4 transfer failed', rt);
    const rAccept = await api('POST', `/missions/${m.id}/accept`, {}, o3[10].token);
    state.s34 = { missionId: m.id, acceptStatus: rAccept.status, acceptError: rAccept.data?.error };
  }

  // ── 4.4 — edit-request expire automatiquement ─────────────
  {
    const m = await createMission(300, 48);
    await interestAndHire(m.id, o3[11]);
    const re = await api('PUT', `/missions/${m.id}`, { title: 'Titre modifié — scénario 4.4 nouveau titre valide' }, accounts.client.token);
    assert(re.status === 202, '4.4 edit-request failed', re);
    state.s44 = { missionId: m.id, oeilId: o3[11].id, editRequestId: re.data.edit_request.id, originalTitle: m.title };
  }

  require('fs').writeFileSync(require('path').join(__dirname, 'batch_state2.json'), JSON.stringify(state, null, 2));
  console.log('OK — batch2 setup terminé:', JSON.stringify(state, null, 2));
  await end();
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
