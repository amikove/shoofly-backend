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
//
// Notification admin (2026-07-31bis) — même pattern que les tickets urgents/réclamations
// (routes/tickets.js, routes/missions.js) : notify() avec titleKey/bodyKey pour chaque admin actif
// + un seul io.to('room:admin').emit(...) par alerte pour la diffusion temps réel. `io`/`emitToUser`
// sont optionnels (défaut null) pour ne rien casser des appels existants qui passent juste `db`
// (scripts de test) — notify() écrit toujours la ligne `notifications`, seule l'émission live est
// sautée sans emitToUser. Ne se déclenche QUE sur les lignes réellement NOUVELLES (retournées par le
// RETURNING ci-dessous) : l'anti-doublon SQL existant (NOT EXISTS sur une ligne non résolue) suffit
// donc aussi à garantir zéro notification répétée pour un même écart déjà signalé.
const { notify } = require('../routes/missions');

async function runWalletReconciliation(db, io = null, emitToUser = null) {
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

  if (alerts.length) {
    // Hoistées hors de la boucle par alerte (et non re-requêtées par admin) — même leçon que
    // l'audit perf du 07-26 (RAPPORT_AUDIT_PERFORMANCE.md) sur les autres crons de ce fichier index.js.
    const { rows: admins } = await db.query(`SELECT id FROM users WHERE role='admin' AND is_active=true`);
    const { rows: named } = await db.query(
      `SELECT id, first_name, last_name FROM users WHERE id = ANY($1::text[])`,
      [alerts.map(a => a.user_id)]
    );
    const userNames = new Map(named.map(u => [u.id, `${u.first_name} ${u.last_name}`]));

    for (const a of alerts) {
      console.error(`🚨 Écart de réconciliation détecté — user_id=${a.user_id} (${a.user_type}) solde=${a.stored_balance} ledger=${a.ledger_balance} écart=${a.discrepancy}`);

      // NUMERIC(10,2) revient en string via pg — toujours passer par Number() avant tout calcul/format.
      const discrepancy = Number(a.discrepancy);
      const storedBalance = Number(a.stored_balance);
      const ledgerBalance = Number(a.ledger_balance);
      const userName = userNames.get(a.user_id) || a.user_id;
      const roleLabel = a.user_type === 'oeil' ? 'Œil' : 'Client';

      const title = '⚠️ Écart de réconciliation détecté';
      const body = `${userName} (${roleLabel}, ${a.user_id}) — solde ${storedBalance.toFixed(2)} MAD vs ledger ${ledgerBalance.toFixed(2)} MAD (écart ${discrepancy.toFixed(2)} MAD). Alerte #${a.id}.`;
      const params = {
        alertId: a.id, userId: a.user_id, userType: a.user_type, userName,
        discrepancy, storedBalance, ledgerBalance,
      };

      for (const admin of admins) {
        await notify(
          db, admin.id, title, body, 'warning', null, emitToUser, 'admin_wallet_reconciliation',
          'walletReconciliationAlertAdminTitle', 'walletReconciliationAlertAdminBody', params
        );
      }
      if (io) {
        io.to('room:admin').emit('wallet_reconciliation_alert_created', {
          alertId: a.id, userId: a.user_id, userType: a.user_type, discrepancy,
        });
      }
    }
  }
  return alerts;
}

module.exports = { runWalletReconciliation };
