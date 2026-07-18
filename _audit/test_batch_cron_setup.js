// Batch groupé partageant les crons */2min (sélection candidat) et */5min (deadlines transfert
// + expiration edit-request) : 2.7, 2.9, 3.1, 3.2, 3.3, 3.4, 4.4.
const { db, api, end, setSetting } = require('./lib');
const accounts = require('./accounts_s.json');

function iso(hOffset) { return new Date(Date.now() + hOffset * 3600000).toISOString(); }
const o2 = accounts.oeils2;

async function createMission(price, hOffset, extra = {}) {
  const r = await api('POST', '/missions', {
    type: 'immobilier', title: `Batch cron — ${Math.random().toString(36).slice(2, 8)}`, address: '3 rue Al Massira',
    city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(hOffset), price, property_type: 'appartement', visit_type: 'physique', ...extra,
  }, accounts.client.token);
  if (r.status !== 201) throw new Error('create mission failed: ' + JSON.stringify(r));
  return r.data.mission;
}

async function main() {
  const state = {};

  // Réduction des délais partagés par ce batch
  await setSetting('candidate_window_minutes_fast', '0.05', accounts.admin.token);        // ~3s
  await setSetting('candidate_window_minutes_choose_other', '0.05', accounts.admin.token); // ~3s
  await setSetting('transfer_grace_minutes_other', '6', accounts.admin.token);             // 6 min (laisse la sélection de candidat passer avant)
  await setSetting('mission_edit_approval_minutes', '6', accounts.admin.token);            // 6 min

  // ── 2.7 — during, aucun remplaçant → cancel, -70 fiabilité, -100 pénalité, cooldown ──
  {
    const m = await createMission(320, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, o2[0].token);
    await api('POST', `/missions/${m.id}/hire/${o2[0].id}`, {}, accounts.client.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'en_route' }, o2[0].token);
    await api('POST', `/missions/${m.id}/status`, { status: 'active' }, o2[0].token);
    const r = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement (2.7)' }, o2[0].token);
    if (r.status !== 200 || r.data.transfer_type !== 'during') throw new Error('2.7 transfer failed: ' + JSON.stringify(r));
    state.s27 = { missionId: m.id, oeilId: o2[0].id, price: 320, balanceBefore: parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [o2[0].id]))[0].balance) };
  }

  // ── 2.9 — before, aucun remplaçant → cancel, -10 fiabilité SEULEMENT (pas de pénalité $) ──
  {
    const m = await createMission(280, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, o2[1].token);
    await api('POST', `/missions/${m.id}/hire/${o2[1].id}`, {}, accounts.client.token);
    const r = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement (2.9)' }, o2[1].token);
    if (r.status !== 200 || r.data.transfer_type !== 'before') throw new Error('2.9 transfer failed: ' + JSON.stringify(r));
    state.s29 = { missionId: m.id, oeilId: o2[1].id, price: 280, balanceBefore: parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [o2[1].id]))[0].balance) };
  }

  // ── 3.1 — fast, 2 candidats score différent → meilleur sélectionné ────────
  {
    const m = await createMission(300, 24); // replacement_preference défaut = 'fast'
    await api('POST', `/missions/${m.id}/interest`, {}, o2[2].token);
    await api('POST', `/missions/${m.id}/hire/${o2[2].id}`, {}, accounts.client.token);
    const r = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement (3.1)' }, o2[2].token);
    if (r.status !== 200) throw new Error('3.1 transfer failed: ' + JSON.stringify(r));
    await db(`UPDATE users SET reliability_score=95 WHERE id=$1`, [o2[3].id]);
    await db(`UPDATE users SET reliability_score=60 WHERE id=$1`, [o2[4].id]);
    await api('POST', `/missions/${m.id}/interest`, {}, o2[4].token); // le moins bon postule en premier
    await api('POST', `/missions/${m.id}/interest`, {}, o2[3].token); // le meilleur postule ensuite
    state.s31 = { missionId: m.id, bestOeilId: o2[3].id, worstOeilId: o2[4].id };
  }

  // ── 3.2 — choose, client choisit manuellement AVANT expiration ───────────
  {
    const m = await createMission(300, 24, { replacement_preference: 'choose' });
    await api('POST', `/missions/${m.id}/interest`, {}, o2[5].token);
    await api('POST', `/missions/${m.id}/hire/${o2[5].id}`, {}, accounts.client.token);
    const rt = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement (3.2)' }, o2[5].token);
    if (rt.status !== 200) throw new Error('3.2 transfer failed: ' + JSON.stringify(rt));
    await api('POST', `/missions/${m.id}/interest`, {}, o2[6].token);
    // Client choisit IMMÉDIATEMENT (bien avant l'expiration de la fenêtre de ~3s) via /hire
    const rh = await api('POST', `/missions/${m.id}/hire/${o2[6].id}`, {}, accounts.client.token);
    if (rh.status !== 200) throw new Error('3.2 hire manuel failed: ' + JSON.stringify(rh));
    state.s32 = { missionId: m.id, chosenOeilId: o2[6].id, hireResponseStatus: rh.data.mission.status, windowClearedImmediately: rh.data.mission.candidate_window_ends_at === null };
  }

  // ── 3.3 — choose, personne ne répond → sélection auto par défaut ─────────
  {
    const m = await createMission(300, 24, { replacement_preference: 'choose' });
    await api('POST', `/missions/${m.id}/interest`, {}, o2[7].token);
    await api('POST', `/missions/${m.id}/hire/${o2[7].id}`, {}, accounts.client.token);
    const rt = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement (3.3)' }, o2[7].token);
    if (rt.status !== 200) throw new Error('3.3 transfer failed: ' + JSON.stringify(rt));
    await api('POST', `/missions/${m.id}/interest`, {}, o2[8].token); // seul candidat, personne (client) ne le choisit manuellement
    state.s33 = { missionId: m.id, onlyCandidateId: o2[8].id };
  }

  // ── 3.4 — POST /accept pendant fenêtre active → bloqué ────────────────────
  {
    const m = await createMission(300, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, o2[9].token);
    await api('POST', `/missions/${m.id}/hire/${o2[9].id}`, {}, accounts.client.token);
    const rt = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement (3.4)' }, o2[9].token);
    if (rt.status !== 200) throw new Error('3.4 transfer failed: ' + JSON.stringify(rt));
    // Un tout nouvel Œil tente d'accepter directement PENDANT la fenêtre de candidature active
    const rAccept = await api('POST', `/missions/${m.id}/accept`, {}, accounts.oeils[0].token);
    state.s34 = { missionId: m.id, acceptStatus: rAccept.status, acceptError: rAccept.data?.error };
  }

  // ── 4.4 — edit-request expire automatiquement (pas de réponse Œil) ───────
  {
    const m = await createMission(300, 48); // >4h → pas de seuil urgent
    await api('POST', `/missions/${m.id}/interest`, {}, accounts.oeils[1].token);
    await api('POST', `/missions/${m.id}/hire/${accounts.oeils[1].id}`, {}, accounts.client.token);
    const re = await api('PUT', `/missions/${m.id}`, { title: 'Titre modifié — scénario 4.4 nouveau titre valide' }, accounts.client.token);
    if (re.status !== 202) throw new Error('4.4 edit-request failed: ' + JSON.stringify(re));
    state.s44 = { missionId: m.id, oeilId: accounts.oeils[1].id, editRequestId: re.data.edit_request.id };
  }

  require('fs').writeFileSync(require('path').join(__dirname, 'batch_state.json'), JSON.stringify(state, null, 2));
  console.log('Setup batch terminé:', JSON.stringify(state, null, 2));
  await end();
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
