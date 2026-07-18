// Catégorie 2.6 (during + remplaçant, chaîne 2 puis 3) et 2.8 (before + remplaçant).
const { db, api, end } = require('./lib');
const accounts = require('./accounts_s.json');

function iso(hOffset) { return new Date(Date.now() + hOffset * 3600000).toISOString(); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function createMission(price, hOffset) {
  const r = await api('POST', '/missions', {
    type: 'immobilier', title: `Scénario cat2-transfer — ${Math.random().toString(36).slice(2, 8)}`, address: '8 rue Moulay Ismail',
    city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(hOffset), price, property_type: 'appartement', visit_type: 'physique',
  }, accounts.client.token);
  if (r.status !== 201) throw new Error('create mission failed: ' + JSON.stringify(r));
  return r.data.mission;
}

async function main() {
  const results = [];

  // ── 2.6 — Transfert 'during', chaîne à 2 PUIS 3 Œils, split prorata exact ──
  {
    const price = 600;
    const oeil0 = accounts.oeils[0], oeil1 = accounts.oeils[1], oeil2 = accounts.oeils[2];
    const bal0Before = parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil0.id]))[0].balance);
    const bal1Before = parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil1.id]))[0].balance);
    const bal2Before = parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil2.id]))[0].balance);

    const m = await createMission(price, 24);
    // Oeil0 embauché, va active (ouvre chain row1)
    await api('POST', `/missions/${m.id}/interest`, {}, oeil0.token);
    await api('POST', `/missions/${m.id}/hire/${oeil0.id}`, {}, accounts.client.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'en_route' }, oeil0.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'active' }, oeil0.token);
    await sleep(3000); // durée mesurable oeil0

    // Oeil0 signale empêchement pendant la mission → transfer_type='during', chain row1 fermée
    let r = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement médical' }, oeil0.token);
    if (r.status !== 200 || r.data.transfer_type !== 'during') throw new Error('2.6 transfer#1 failed: ' + JSON.stringify(r));

    // Client hire directement Oeil1 (remplaçant #1) — chain row2 ouverte à l'embauche
    await api('POST', `/missions/${m.id}/interest`, {}, oeil1.token);
    r = await api('POST', `/missions/${m.id}/hire/${oeil1.id}`, {}, accounts.client.token);
    if (r.status !== 200) throw new Error('2.6 hire oeil1 failed: ' + JSON.stringify(r));
    await api('POST', `/missions/${m.id}/status`, { status: 'en_route' }, oeil1.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'active' }, oeil1.token);
    await sleep(5000); // durée mesurable oeil1 (plus longue qu'oeil0)

    // Oeil1 signale empêchement à son tour (pendant la mission, status=active → transferType='during')
    r = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement également' }, oeil1.token);
    if (r.status !== 200 || r.data.transfer_type !== 'during') throw new Error('2.6 transfer#2 failed: ' + JSON.stringify(r));

    // Client hire Oeil2 (remplaçant #2) — chain row3 ouverte à l'embauche
    await api('POST', `/missions/${m.id}/interest`, {}, oeil2.token);
    r = await api('POST', `/missions/${m.id}/hire/${oeil2.id}`, {}, accounts.client.token);
    if (r.status !== 200) throw new Error('2.6 hire oeil2 failed: ' + JSON.stringify(r));
    await api('POST', `/missions/${m.id}/status`, { status: 'en_route' }, oeil2.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'active' }, oeil2.token);
    await sleep(2000);
    await api('POST', `/missions/${m.id}/status`, { status: 'completed' }, oeil2.token);

    // Validation client → split prorata sur les 3 maillons
    r = await api('POST', `/missions/${m.id}/validate`, {}, accounts.client.token);
    if (r.status !== 200) throw new Error('2.6 validate failed: ' + JSON.stringify(r));

    // Vérif : lire les 3 lignes de chaîne (durées réelles) + calculer le split ATTENDU à partir de CES durées
    const chain = await db(`SELECT oeil_id, started_at, ended_at, earning_share, sequence_order FROM mission_transfer_chain WHERE mission_id=$1 ORDER BY sequence_order`, [m.id]);
    const [mRow] = await db('SELECT oeil_earning FROM missions WHERE id=$1', [m.id]);
    const oeilEarning = parseFloat(mRow.oeil_earning);
    const durations = chain.map(c => Math.max(0, new Date(c.ended_at) - new Date(c.started_at)));
    const totalDuration = durations.reduce((s, d) => s + d, 0);
    const expectedShares = chain.map((c, i) => Math.round(oeilEarning * (durations[i] / totalDuration) * 100) / 100);

    const bal0After = parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil0.id]))[0].balance);
    const bal1After = parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil1.id]))[0].balance);
    const bal2After = parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil2.id]))[0].balance);
    const delta0 = Math.round((bal0After - bal0Before) * 100) / 100;
    const delta1 = Math.round((bal1After - bal1Before) * 100) / 100;
    const delta2 = Math.round((bal2After - bal2Before) * 100) / 100;

    const sumShares = Math.round((expectedShares[0] + expectedShares[1] + expectedShares[2]) * 100) / 100;

    results.push({
      scenario: '2.6 — Chaîne during à 3 Œils, split prorata',
      expected: `3 maillons, parts calculées sur durées réelles (${durations.join('ms, ')}ms), somme=${oeilEarning} (±arrondi), delta balance = part exacte pour chacun`,
      observed: `chain.earning_share=[${chain.map(c=>c.earning_share).join(', ')}], attendu=[${expectedShares.join(', ')}], deltas balance=[${delta0}, ${delta1}, ${delta2}], somme parts=${sumShares}`,
      ok: chain.length === 3
        && parseFloat(chain[0].earning_share) === expectedShares[0] && delta0 === expectedShares[0]
        && parseFloat(chain[1].earning_share) === expectedShares[1] && delta1 === expectedShares[1]
        && parseFloat(chain[2].earning_share) === expectedShares[2] && delta2 === expectedShares[2]
        && Math.abs(sumShares - oeilEarning) <= 0.02, // tolérance 2 centimes pour 2 arrondis cumulés
    });
  }

  // ── 2.8 — Transfert 'before' (avant démarrage), remplaçant trouvé ─────────
  // +5 fiabilité, PAS de split, paiement intégral au 2e Œil, aucune ligne de chaîne financière.
  {
    const price = 280;
    const oeil3 = accounts.oeils[3], oeil4 = accounts.oeils[4];
    const [relBefore] = await db(`SELECT reliability_score FROM users WHERE id=$1`, [oeil3.id]);
    const bal4Before = parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil4.id]))[0].balance);

    const m = await createMission(price, 24);
    await api('POST', `/missions/${m.id}/interest`, {}, oeil3.token);
    await api('POST', `/missions/${m.id}/hire/${oeil3.id}`, {}, accounts.client.token);
    // Oeil3 signale empêchement AVANT démarrage (status encore 'assigned' → transferType='before')
    let r = await api('POST', `/missions/${m.id}/transfer`, { reason: 'Empêchement avant départ' }, oeil3.token);
    if (r.status !== 200 || r.data.transfer_type !== 'before') throw new Error('2.8 transfer failed: ' + JSON.stringify(r));

    await api('POST', `/missions/${m.id}/interest`, {}, oeil4.token);
    r = await api('POST', `/missions/${m.id}/hire/${oeil4.id}`, {}, accounts.client.token);
    if (r.status !== 200) throw new Error('2.8 hire oeil4 failed: ' + JSON.stringify(r));
    await api('POST', `/missions/${m.id}/status`, { status: 'en_route' }, oeil4.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'active' }, oeil4.token);
    await api('POST', `/missions/${m.id}/status`, { status: 'completed' }, oeil4.token);
    r = await api('POST', `/missions/${m.id}/validate`, {}, accounts.client.token);
    if (r.status !== 200) throw new Error('2.8 validate failed: ' + JSON.stringify(r));

    const [relAfter] = await db(`SELECT reliability_score FROM users WHERE id=$1`, [oeil3.id]);
    const [relEvent] = await db(`SELECT points, reason FROM reliability_events WHERE oeil_id=$1 AND mission_id=$2 ORDER BY id DESC LIMIT 1`, [oeil3.id, m.id]);
    const chainRows = await db(`SELECT * FROM mission_transfer_chain WHERE mission_id=$1`, [m.id]);
    const [mRow] = await db('SELECT oeil_earning FROM missions WHERE id=$1', [m.id]);
    const bal4After = parseFloat((await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil4.id]))[0].balance);
    const delta4 = Math.round((bal4After - bal4Before) * 100) / 100;

    results.push({
      scenario: '2.8 — Transfert before + remplaçant : +5 fiabilité Œil1, aucune ligne de chaîne, paiement intégral Œil2',
      expected: `reliability_event +5 pour oeil3, 0 ligne mission_transfer_chain, Œil4 crédité oeil_earning intégral (${mRow.oeil_earning})`,
      observed: `event=${relEvent ? relEvent.points + ' (' + relEvent.reason + ')' : 'aucun'}, score ${relBefore.reliability_score}→${relAfter.reliability_score}, chain_rows=${chainRows.length}, delta Œil4=+${delta4}`,
      ok: relEvent?.points === 5 && chainRows.length === 0 && delta4 === parseFloat(mRow.oeil_earning),
    });
  }

  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results_cat2_transfer_found.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} OK`);
  if (failed.length) console.log('ÉCHECS:', JSON.stringify(failed, null, 2));
  await end();
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
