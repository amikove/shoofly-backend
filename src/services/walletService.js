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

// ── Idempotence optionnelle (ID-1, audit perf/concurrence 2026-09-19) ────────────────────────────
// credit()/debit() acceptent opts.idempotencyKey : filet de sécurité pour du code FUTUR (webhook rejoué,
// double clic, reprise après crash…) — AUCUN appelant actuel n'en passe (leur comportement, leur valeur
// de retour `undefined` et leur suite d'instructions SQL sont strictement inchangés).
// Avec une clé (chaîne de 1 à 200 caractères, unique pour l'opération métier — ex. "withdrawal-refund:42") :
//   - 1er appel : applique le mouvement et rend { applied: true, balance } ;
//   - rejeu (même clé) : NE TOUCHE PAS au solde, ne lève rien, rend { applied: false, balance } ;
//     pour un débit, le rejeu est détecté AVANT le contrôle de solde (rejouer un débit qui a vidé le
//     solde ne doit pas lever 'Solde insuffisant') ;
//   - même clé pour une AUTRE opération (autre utilisateur/type/montant) : lève IDEMPOTENCY_KEY_REUSED
//     plutôt que d'ignorer silencieusement un mouvement d'argent distinct ;
//   - la clé et le mouvement sont écrits dans la MÊME transaction : si l'appelant annule (ROLLBACK), la
//     clé n'est pas consommée et l'opération pourra être rejouée.
// Ordre voulu : verrou de la ligne de solde (sérialise deux appels concurrents du même utilisateur) →
// clé déjà connue ? → (débit) contrôle de solde → INSERT ledger ... ON CONFLICT DO NOTHING (arbitre
// atomique de la clé) → UPDATE solde. Toute erreur applicative (solde insuffisant, utilisateur
// introuvable) est levée AVANT la réservation de la clé : aucune clé « brûlée » sans effet dans une
// transaction que l'appelant poursuivrait après avoir rattrapé l'erreur. Le prédicat WHERE de
// ON CONFLICT est obligatoire : sans lui Postgres ne peut pas inférer l'index unique PARTIEL.
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

function normalizeIdempotencyKey(fnName, key) {
  if (key === undefined || key === null) return null;
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new TypeError(`walletService.${fnName}: idempotencyKey invalide (chaîne de 1 à ${MAX_IDEMPOTENCY_KEY_LENGTH} caractères attendue)`);
  }
  return key;
}

// Même clé = même opération financière : utilisateur, sens et montant (au centime) identiques. Le libellé
// (reason) n'est volontairement pas comparé : un rejeu légitime peut le reformuler.
function assertSameOperation(fnName, key, existing, userId, type, amount) {
  const sameAmount = Math.round(parseFloat(existing.amount) * 100) === Math.round(amount * 100);
  if (existing.user_id !== userId || existing.type !== type || !sameAmount) {
    const err = new Error(`walletService.${fnName}: idempotencyKey "${key}" déjà utilisée pour une autre opération (utilisateur/sens/montant différents)`);
    err.code = 'IDEMPOTENCY_KEY_REUSED';
    throw err;
  }
}

async function applyIdempotent(client, { fnName, userId, userType, type, amount, reason, missionId, key, extraSet = '' }) {
  const { table, column } = resolveTarget(userType);
  const { rows: [row] } = await client.query(
    `SELECT balance FROM ${table} WHERE ${column}=$1 FOR UPDATE`,
    [userId]
  );
  if (!row) throw new Error(`walletService.${fnName}: utilisateur introuvable (${userId})`);
  const currentBalance = parseFloat(row.balance);

  const { rows: [known] } = await client.query(
    `SELECT user_id, type, amount FROM wallet_transactions WHERE idempotency_key=$1`,
    [key]
  );
  if (known) {
    assertSameOperation(fnName, key, known, userId, type, amount);
    return { applied: false, balance: currentBalance };
  }

  if (type === 'debit' && currentBalance < amount) {
    const err = new Error('Solde insuffisant');
    err.code = 'INSUFFICIENT_BALANCE';
    throw err;
  }

  const { rows: [inserted] } = await client.query(
    `INSERT INTO wallet_transactions (user_id, type, amount, reason, mission_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, type, amount, reason, missionId, key]
  );
  if (!inserted) {
    // La clé vient d'être prise par une transaction concurrente. Même utilisateur : impossible (le verrou
    // de ligne ci-dessus sérialise ses appels). Autre utilisateur : mauvaise réutilisation de la clé.
    const { rows: [now] } = await client.query(
      `SELECT user_id, type, amount FROM wallet_transactions WHERE idempotency_key=$1`,
      [key]
    );
    if (now) assertSameOperation(fnName, key, now, userId, type, amount);
    return { applied: false, balance: currentBalance };
  }

  await client.query(`SET LOCAL app.wallet_write_allowed = 'true'`);
  const sign = type === 'credit' ? '+' : '-';
  const { rows: [after] } = await client.query(
    `UPDATE ${table} SET balance=balance${sign}$1${extraSet} WHERE ${column}=$2 RETURNING balance`,
    [amount, userId]
  );
  return { applied: true, balance: parseFloat(after.balance) };
}

// opts.countsAsEarning (défaut true) : à mettre à false quand le crédit restitue un solde déjà
// comptabilisé (ex: rejet d'un retrait) plutôt qu'un nouveau gain — sinon total_earnings serait
// gonflé en double (le montant a déjà été compté lors du gain initial ; debit() ne décrémente
// jamais total_earnings, donc le recréditer via credit() sans ce garde-fou compterait deux fois).
// opts.idempotencyKey (optionnel) : voir « Idempotence optionnelle » ci-dessus.
async function credit(db, userId, userType, amount, reason, missionId = null, opts = {}) {
  if (!isCheckedOutClient(db)) {
    return withTransaction(db, (client) => credit(client, userId, userType, amount, reason, missionId, opts));
  }
  const client = db;
  if (!(amount > 0)) throw new Error(`walletService.credit: montant invalide (${amount})`);
  const { countsAsEarning = true, idempotencyKey } = opts;
  const { table, column } = resolveTarget(userType);
  const extraSet = (userType === 'oeil' && countsAsEarning) ? ', total_earnings=total_earnings+$1' : '';
  const key = normalizeIdempotencyKey('credit', idempotencyKey);
  if (key !== null) {
    return applyIdempotent(client, { fnName: 'credit', userId, userType, type: 'credit', amount, reason, missionId, key, extraSet });
  }
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
// opts.idempotencyKey (optionnel) : voir « Idempotence optionnelle » plus haut.
async function debit(db, userId, userType, amount, reason, missionId = null, opts = {}) {
  if (!isCheckedOutClient(db)) {
    return withTransaction(db, (client) => debit(client, userId, userType, amount, reason, missionId, opts));
  }
  const client = db;
  if (!(amount > 0)) throw new Error(`walletService.debit: montant invalide (${amount})`);
  const { table, column } = resolveTarget(userType);
  const key = normalizeIdempotencyKey('debit', opts.idempotencyKey);
  if (key !== null) {
    return applyIdempotent(client, { fnName: 'debit', userId, userType, type: 'debit', amount, reason, missionId, key });
  }
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
