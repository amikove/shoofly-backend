// Catégorie 1 — Cycle de vie normal (1.1, 1.3). 1.2 (auto-validation cron) traité à part (batch 20h00).
const { db, api, end } = require('./lib');
const accounts = require('./accounts_s.json');

function iso(hOffset) { return new Date(Date.now() + hOffset * 3600000).toISOString(); }

async function main() {
  const results = [];
  const client = accounts.client;
  const oeil = accounts.oeils[0];

  // Solde oeil AVANT (pour delta exact)
  const before = await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil.id]);
  const balanceBefore = parseFloat(before[0].balance);

  // 1) Création mission price=300
  const price = 300;
  let r = await api('POST', '/missions', {
    type: 'immobilier', title: 'Visite appartement Agdal — scénario 1.1', address: '12 rue des Fleurs',
    city: 'Rabat', quartier: 'Agdal', scheduled_at: iso(24), price, property_type: 'appartement', visit_type: 'physique',
  }, client.token);
  if (r.status !== 201) throw new Error('create mission failed: ' + JSON.stringify(r));
  const mission = r.data.mission;
  console.log('Mission créée:', mission.id, 'price=', mission.price, 'commission=', mission.commission, 'oeil_earning=', mission.oeil_earning);

  const expectedCommission = Math.round(price * 0.20 * 100) / 100;
  const expectedEarning = price - expectedCommission;
  results.push({
    scenario: '1.1 — commission/oeil_earning calculés à la création',
    expected: `commission=${expectedCommission}, oeil_earning=${expectedEarning}`,
    observed: `commission=${mission.commission}, oeil_earning=${mission.oeil_earning}`,
    ok: parseFloat(mission.commission) === expectedCommission && parseFloat(mission.oeil_earning) === expectedEarning,
  });

  // 2) Oeil postule
  r = await api('POST', `/missions/${mission.id}/interest`, { message: 'Disponible' }, oeil.token);
  if (r.status !== 201) throw new Error('interest failed: ' + JSON.stringify(r));

  // 3) Client embauche
  r = await api('POST', `/missions/${mission.id}/hire/${oeil.id}`, {}, client.token);
  if (r.status !== 200) throw new Error('hire failed: ' + JSON.stringify(r));
  results.push({ scenario: '1.1 — embauche → assigned', expected: 'status=assigned', observed: `status=${r.data.mission.status}`, ok: r.data.mission.status === 'assigned' });

  // 4) Oeil progresse : en_route -> active -> completed
  r = await api('POST', `/missions/${mission.id}/status`, { status: 'en_route' }, oeil.token);
  if (r.status !== 200) throw new Error('en_route failed: ' + JSON.stringify(r));
  r = await api('POST', `/missions/${mission.id}/status`, { status: 'active' }, oeil.token);
  if (r.status !== 200) throw new Error('active failed: ' + JSON.stringify(r));
  r = await api('POST', `/missions/${mission.id}/status`, { status: 'completed' }, oeil.token);
  if (r.status !== 200) throw new Error('completed failed: ' + JSON.stringify(r));
  results.push({
    scenario: '1.1 — Œil termine → completed',
    expected: 'status=completed, completed_by_oeil_at renseigné',
    observed: `status=${r.data.mission.status}, completed_by_oeil_at=${r.data.mission.completed_by_oeil_at}`,
    ok: r.data.mission.status === 'completed' && !!r.data.mission.completed_by_oeil_at,
  });

  // 5) Client valide dans les 12h (immédiat)
  r = await api('POST', `/missions/${mission.id}/validate`, {}, client.token);
  if (r.status !== 200) throw new Error('validate failed: ' + JSON.stringify(r));

  // Vérif DB : mission.validated_at, wallet_transactions, oeil_profiles.balance
  const [mRow] = await db('SELECT validated_at, status FROM missions WHERE id=$1', [mission.id]);
  const [wtRow] = await db(`SELECT type, amount, reason FROM wallet_transactions WHERE mission_id=$1 AND user_id=$2`, [mission.id, oeil.id]);
  const after = await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [oeil.id]);
  const balanceAfter = parseFloat(after[0].balance);
  const delta = Math.round((balanceAfter - balanceBefore) * 100) / 100;

  results.push({
    scenario: '1.1 — validation client : paiement Œil exact',
    expected: `wallet_transactions: credit ${expectedEarning} (reason="Validation client"), delta balance=+${expectedEarning}`,
    observed: `wallet_transactions: ${wtRow.type} ${wtRow.amount} (reason="${wtRow.reason}"), delta balance=+${delta}`,
    ok: mRow.validated_at !== null && wtRow.type === 'credit' && parseFloat(wtRow.amount) === expectedEarning && wtRow.reason === 'Validation client' && delta === expectedEarning,
  });

  // 1.3 — Tentative de réclamation après validation → doit être bloquée
  r = await api('POST', `/missions/${mission.id}/claim`, { comment: 'Je conteste après coup' }, client.token);
  results.push({
    scenario: '1.3 — réclamation après validation → bloquée',
    expected: 'HTTP 400, "déjà été validée"',
    observed: `HTTP ${r.status}, ${JSON.stringify(r.data)}`,
    ok: r.status === 400 && /déjà été validée/i.test(r.data?.error || ''),
  });

  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(require('path').join(__dirname, 'results_cat1.json'), JSON.stringify({ missionId: mission.id, results }, null, 2));
  await end();
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
