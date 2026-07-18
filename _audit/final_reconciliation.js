// Réconciliation financière finale : pour chaque compte de test utilisé dans cette session,
// SUM(wallet_transactions credit) - SUM(debit) doit égaler le solde réel en base, à 0.00 près.
const { db, end } = require('./lib');

async function main() {
  // Tous les comptes créés pendant cette session (préfixes s_/s2_/s3_/s4_/s5_ + admin non-super créé)
  const users = await db(`
    SELECT id, email, role FROM users
    WHERE email LIKE '%@test.local'
    ORDER BY email
  `);

  const rows = [];
  let anyMismatch = false;

  for (const u of users) {
    const wt = await db(`SELECT type, SUM(amount)::numeric AS total FROM wallet_transactions WHERE user_id=$1 GROUP BY type`, [u.id]);
    const credit = parseFloat(wt.find(w => w.type === 'credit')?.total || 0);
    const debit = parseFloat(wt.find(w => w.type === 'debit')?.total || 0);
    const theoretical = Math.round((credit - debit) * 100) / 100;

    let real;
    if (u.role === 'oeil') {
      const [p] = await db('SELECT balance FROM oeil_profiles WHERE user_id=$1', [u.id]);
      real = p ? parseFloat(p.balance) : null;
    } else {
      const [uu] = await db('SELECT balance FROM users WHERE id=$1', [u.id]);
      real = parseFloat(uu.balance);
    }

    const gap = real === null ? null : Math.round((real - theoretical) * 100) / 100;
    if (gap !== 0 && gap !== null) anyMismatch = true;

    if (credit > 0 || debit > 0 || (real !== null && real !== 0)) {
      rows.push({ email: u.email, role: u.role, credit, debit, theoretical, real, gap, ok: gap === 0 });
    }
  }

  console.log(JSON.stringify(rows, null, 2));
  console.log(`\nTotal comptes avec mouvement: ${rows.length}, écarts détectés: ${rows.filter(r => !r.ok).length}`);
  require('fs').writeFileSync(require('path').join(__dirname, 'final_reconciliation_result.json'), JSON.stringify(rows, null, 2));
  await end();
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
