// Primitive unique pour tout mouvement de solde (crédit/débit), quel que soit
// l'appelant (validation mission, remboursement, bonus, pénalité, retrait...).
//
// Pourquoi : avant ce module, chaque endroit qui touchait un solde refaisait à la
// main la paire "UPDATE balance" + "INSERT wallet_transactions" — c'est exactement
// ce défaut qui a produit le bug corrigé sur POST /oeil/withdraw (le solde était
// débité sans jamais journaliser la ligne correspondante). En centralisant les deux
// écritures dans une seule fonction, il devient impossible d'écrire l'une sans l'autre.
//
// Verrou structurel (2026-07-31) : un trigger Postgres (schema.js) rejette désormais
// toute écriture sur oeil_profiles.balance / users.balance qui n'a pas posé au
// préalable `SET LOCAL app.wallet_write_allowed = 'true'` dans la MÊME transaction —
// credit()/debit() le posent juste avant leur UPDATE, ce qui rend la classe de bug
// FAIL1 (UPDATE brut sans ligne wallet_transactions) impossible ailleurs dans le code,
// pas seulement déconseillée par convention. Voir RAPPORT_VERROUILLAGE_BALANCE.md.
//
// credit()/debit() acceptent indifféremment le pool (getDb()) ou un client déjà en
// transaction — appelées avec un client déjà en transaction, elles y composent
// directement (ex: transitionMission + walletService.credit dans la même transaction
// atomique) ; appelées avec le pool brut, elles ouvrent leur propre transaction courte
// via withTransaction. Ce second cas est nécessaire pour que SET LOCAL ait un effet :
// posé sur une connexion auto-commit (une instruction = une transaction implicite), il
// serait sans effet dès l'instruction suivante, qui pourrait tourner sur une connexion
// différente du pool — voir isCheckedOutClient ci-dessous.

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

// Un objet client obtenu via pool.connect() porte .release() (ajouté par node-postgres) ;
// le pool lui-même (getDb()) non — distingue les deux formes acceptées par credit()/debit()
// pour savoir s'il faut ouvrir sa propre transaction avant d'écrire. Vérifié empiriquement
// (voir RAPPORT_VERROUILLAGE_BALANCE.md) plutôt que supposé sur la seule doc node-postgres.
function isCheckedOutClient(db) {
  return typeof db.release === 'function';
}

// Verrouille la ligne de solde (SELECT ... FOR UPDATE) pour sérialiser les accès
// concurrents — à appeler avant credit/debit quand l'appelant a besoin de lire le
// solde pour une décision (ex: vérifier qu'il est suffisant avant de débiter). Contrairement
// à credit()/debit(), n'accepte QUE un client déjà en transaction : verrouiller une ligne
// n'a de sens que si le verrou survit au-delà d'une seule instruction auto-commit.
async function lockBalance(client, userId, userType) {
  const { table, column } = resolveTarget(userType);
  const { rows: [row] } = await client.query(
    `SELECT balance FROM ${table} WHERE ${column}=$1 FOR UPDATE`,
    [userId]
  );
  return row ? parseFloat(row.balance) : null;
}

// opts.countsAsEarning (défaut true) : à mettre à false quand le crédit restitue un solde déjà
// comptabilisé (ex: rejet d'un retrait) plutôt qu'un nouveau gain — sinon total_earnings serait
// gonflé en double (le montant a déjà été compté lors du gain initial ; debit() ne décrémente
// jamais total_earnings, donc le recréditer via credit() sans ce garde-fou compterait deux fois).
async function credit(db, userId, userType, amount, reason, missionId = null, opts = {}) {
  if (!isCheckedOutClient(db)) {
    return withTransaction(db, (client) => credit(client, userId, userType, amount, reason, missionId, opts));
  }
  const client = db;
  if (!(amount > 0)) throw new Error(`walletService.credit: montant invalide (${amount})`);
  const { countsAsEarning = true } = opts;
  const { table, column } = resolveTarget(userType);
  const extraSet = (userType === 'oeil' && countsAsEarning) ? ', total_earnings=total_earnings+$1' : '';
  // Autorise, pour cette transaction seulement, l'UPDATE ci-dessous à passer le trigger
  // DB (schema.js) — SET LOCAL se réinitialise seul au COMMIT/ROLLBACK, aucune remise à
  // zéro manuelle nécessaire.
  await client.query(`SET LOCAL app.wallet_write_allowed = 'true'`);
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
async function debit(db, userId, userType, amount, reason, missionId = null) {
  if (!isCheckedOutClient(db)) {
    return withTransaction(db, (client) => debit(client, userId, userType, amount, reason, missionId));
  }
  const client = db;
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
  // Voir credit() ci-dessus — même flag, même durée de vie (transaction courante).
  await client.query(`SET LOCAL app.wallet_write_allowed = 'true'`);
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
