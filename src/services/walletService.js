// Primitive unique pour tout mouvement de solde (crédit/débit), quel que soit
// l'appelant (validation mission, remboursement, bonus, pénalité, retrait...).
//
// Pourquoi : avant ce module, chaque endroit qui touchait un solde refaisait à la
// main la paire "UPDATE balance" + "INSERT wallet_transactions" — c'est exactement
// ce défaut qui a produit le bug corrigé sur POST /oeil/withdraw (le solde était
// débité sans jamais journaliser la ligne correspondante). En centralisant les deux
// écritures dans une seule fonction, il devient impossible d'écrire l'une sans l'autre.
//
// Ces fonctions NE font PAS leur propre BEGIN/COMMIT : elles reçoivent un `client`
// déjà en transaction (voir withTransaction ci-dessous) pour pouvoir être composées
// avec d'autres écritures (ex: transitionMission + walletService.credit dans la même
// transaction atomique).

const BALANCE_TABLE = {
  oeil:   { table: 'oeil_profiles', column: 'user_id' },
  client: { table: 'users',         column: 'id' },
};

function resolveTarget(userType) {
  const target = BALANCE_TABLE[userType];
  if (!target) throw new Error(`walletService: userType invalide "${userType}" (attendu: 'oeil' ou 'client')`);
  return target;
}

// Encapsule le pattern BEGIN/try/COMMIT/catch/ROLLBACK/finally release déjà posé
// sur POST /oeil/withdraw, pour éviter de le réécrire à chaque nouvel appelant.
async function withTransaction(db, callback) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Verrouille la ligne de solde (SELECT ... FOR UPDATE) pour sérialiser les accès
// concurrents — à appeler avant credit/debit quand l'appelant a besoin de lire le
// solde pour une décision (ex: vérifier qu'il est suffisant avant de débiter).
async function lockBalance(client, userId, userType) {
  const { table, column } = resolveTarget(userType);
  const { rows: [row] } = await client.query(
    `SELECT balance FROM ${table} WHERE ${column}=$1 FOR UPDATE`,
    [userId]
  );
  return row ? parseFloat(row.balance) : null;
}

async function credit(client, userId, userType, amount, reason, missionId = null) {
  if (!(amount > 0)) throw new Error(`walletService.credit: montant invalide (${amount})`);
  const { table, column } = resolveTarget(userType);
  const extraSet = userType === 'oeil' ? ', total_earnings=total_earnings+$1' : '';
  const { rowCount } = await client.query(
    `UPDATE ${table} SET balance=balance+$1${extraSet} WHERE ${column}=$2`,
    [amount, userId]
  );
  if (rowCount === 0) throw new Error(`walletService.credit: utilisateur introuvable (${userId})`);
  await client.query(
    `INSERT INTO wallet_transactions (user_id, type, amount, reason, mission_id) VALUES ($1, 'credit', $2, $3, $4)`,
    [userId, amount, reason, missionId]
  );
}

// La contrainte CHECK(balance >= 0) (oeil_profiles / users) reste le filet de
// sécurité ultime au niveau DB ; cette vérification applicative donne un message
// d'erreur clair côté API plutôt qu'une erreur SQL brute remontée telle quelle.
async function debit(client, userId, userType, amount, reason, missionId = null) {
  if (!(amount > 0)) throw new Error(`walletService.debit: montant invalide (${amount})`);
  const { table, column } = resolveTarget(userType);
  const { rows: [row] } = await client.query(
    `SELECT balance FROM ${table} WHERE ${column}=$1 FOR UPDATE`,
    [userId]
  );
  if (!row) throw new Error(`walletService.debit: utilisateur introuvable (${userId})`);
  if (parseFloat(row.balance) < amount) {
    const err = new Error('Solde insuffisant');
    err.code = 'INSUFFICIENT_BALANCE';
    throw err;
  }
  await client.query(
    `UPDATE ${table} SET balance=balance-$1 WHERE ${column}=$2`,
    [amount, userId]
  );
  await client.query(
    `INSERT INTO wallet_transactions (user_id, type, amount, reason, mission_id) VALUES ($1, 'debit', $2, $3, $4)`,
    [userId, amount, reason, missionId]
  );
}

module.exports = { withTransaction, lockBalance, credit, debit };
