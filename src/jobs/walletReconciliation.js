// Réconciliation automatique du solde — voir schema.js (wallet_reconciliation_alerts) et le
// verrou balance (walletService.js, trigger DB). Compare périodiquement, pour chaque utilisateur
// ayant un solde (oeil_profiles.balance / users.balance, selon BALANCE_TABLE — walletService.js),
// SUM(credit)-SUM(debit) réel (wallet_transactions) au solde stocké, et journalise tout écart
// NOUVELLEMENT détecté. Lecture seule sur balance/wallet_transactions — ne corrige jamais rien
// (seule wallet_reconciliation_alerts reçoit des écritures, en INSERT uniquement ; resolved_at
// n'est jamais posé ici, voir GET/PUT .../wallet-reconciliation-alerts dans routes/users.js pour
// l'action admin explicite). Extrait dans son propre module (même raison que runWhatsAppRetry) —
// testable indépendamment, sans déclencher les effets de bord du require de index.js.
//
// users.role='client' est un filtre nécessaire, pas cosmétique : oeil_profiles.user_id désigne
// déjà exclusivement des utilisateurs role='oeil' (une ligne oeil_profiles n'est créée qu'à
// l'inscription d'un Œil, voir routes/auth.js) — sans ce filtre, un Œil serait aussi comparé côté
// users.balance (toujours 0 pour lui, jamais touché par walletService pour ce rôle) à SON PROPRE
// ledger complet (ses vrais gains/débits, non nul) : un faux positif garanti pour chaque Œil actif.
async function runWalletReconciliation(db) {
  const { rows: alerts } = await db.query(`
    WITH ledger AS (
      SELECT user_id, SUM(CASE WHEN type='credit' THEN amount ELSE -amount END) AS balance
      FROM wallet_transactions
      GROUP BY user_id
    ),
    computed AS (
      SELECT op.user_id AS user_id, 'oeil' AS user_type, op.balance AS stored_balance,
             COALESCE(ledger.balance, 0) AS ledger_balance
      FROM oeil_profiles op
      LEFT JOIN ledger ON ledger.user_id = op.user_id

      UNION ALL

      SELECT u.id AS user_id, 'client' AS user_type, u.balance AS stored_balance,
             COALESCE(ledger.balance, 0) AS ledger_balance
      FROM users u
      LEFT JOIN ledger ON ledger.user_id = u.id
      WHERE u.role = 'client'
    )
    INSERT INTO wallet_reconciliation_alerts (user_id, user_type, ledger_balance, stored_balance, discrepancy)
    SELECT user_id, user_type, ledger_balance, stored_balance, stored_balance - ledger_balance
    FROM computed c
    WHERE ABS(stored_balance - ledger_balance) >= 0.005
      AND NOT EXISTS (
        SELECT 1 FROM wallet_reconciliation_alerts a
        WHERE a.user_id = c.user_id AND a.resolved_at IS NULL
      )
    RETURNING *
  `);

  for (const a of alerts) {
    console.error(`🚨 Écart de réconciliation détecté — user_id=${a.user_id} (${a.user_type}) solde=${a.stored_balance} ledger=${a.ledger_balance} écart=${a.discrepancy}`);
  }
  return alerts;
}

module.exports = { runWalletReconciliation };
