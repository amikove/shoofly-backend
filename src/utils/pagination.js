// ── Validation des paramètres de pagination (`page` / `limit`) ────────────────
// Root cause du Constat #3 (rapport robustesse & sécurité API 2026-09-06, §C.1bis) :
// ~11 routes lisaient `const { page = 1, limit = 20 } = req.query` puis passaient ces
// valeurs BRUTES (chaînes issues de l'URL) à `LIMIT $n OFFSET $n`. Aucune n'est une
// injection (tout est paramétré), mais toute valeur non entière / négative / hors
// `bigint` provoquait un 500 Postgres garanti (SQLSTATE 22P02 / 22003 / 22023).
// Le filet global de `src/index.js` (22P02/22003 → 400) ne rattrape qu'une partie des
// cas (pas 22023 « OFFSET négatif ») et masque la vraie cause. Ce helper corrige à la
// source : un seul point de validation, réutilisé par toutes les routes paginées.
//
// Comportement retenu pour une valeur INVALIDE = rejet 400 (via PaginationError,
// mappée dans le handler d'erreur global), PAS de repli silencieux sur la valeur par
// défaut. Justification :
//   1. Cohérent avec le style du dépôt (validateDurationEst, settingValidators, le
//      garde `status` déjà présent dans 3 de ces routes renvoient tous un 400 net).
//   2. Le frontend n'émet jamais de `page`/`limit` malformés (tous les appelants
//      passent des nombres issus du state ; la plus grande taille de page du code est
//      100). Un 400 n'atteint donc qu'un client cassé ou hostile — précisément celui
//      qui doit voir une erreur claire, pas un « page 1 » silencieux.
//   3. Coercer `?page=1 OR 1=1` ou `?page=abc` en « page 1 » masquerait un bug
//      d'intégration ou un fuzzing.
// Seule exception : un `limit` entier valide mais au-dessus du plafond est RAMENÉ au
// plafond (c'est un plafond, pas une limite stricte) — « donne-moi plus de lignes » a
// une lecture sûre évidente (« le maximum »), « abc » n'en a pas.

// Plafond haut sur `limit` : la plus grande taille de page utilisée dans le code est
// 100 (GET /users/oeils, users.js). ×2 de marge → 200. Assez large pour que tout écran
// actuel ou prévisible tienne (le plus gros, l'annuaire Œils, demande 100), assez bas
// pour qu'une requête ne puisse pas tirer des milliers de lignes d'un coup.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

class PaginationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaginationError';
    this.status = 400;
  }
}

// Un seul paramètre (`page` ou `limit`). Renvoie `null` si absent → l'appelant
// substitue sa valeur par défaut. Sinon : entier positif sûr, ou PaginationError.
function parseIntParam(raw, label) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim();
  // `/^\d+$/` rejette d'emblée : signe (`-5`), virgule (`1.5`), notation exp (`1e5`),
  // texte (`abc`, `1 OR 1=1`), espaces internes. Pas de `parseInt` laxiste.
  if (!/^\d+$/.test(s)) {
    throw new PaginationError(`Paramètre de pagination invalide : « ${label} » doit être un entier positif`);
  }
  const n = Number(s);
  // `99999999999999999999` passe `/^\d+$/` mais dépasse 2^53 → non représentable
  // fidèlement, jamais une vraie taille de page/numéro de page → rejet.
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new PaginationError(`Paramètre de pagination invalide : « ${label} » doit être un entier positif`);
  }
  return n;
}

// Lit `query.page` / `query.limit` et renvoie `{ page, limit, offset }` — trois
// entiers positifs bornés, toujours sûrs à passer en paramètre de `LIMIT $n OFFSET $n`.
// opts.defaultLimit : valeur si `limit` absent (défaut 20 ; passer 100 pour /oeils).
// opts.maxLimit     : plafond de `limit` (défaut 200).
function parsePagination(query = {}, opts = {}) {
  const defaultLimit = opts.defaultLimit || DEFAULT_LIMIT;
  const maxLimit = opts.maxLimit || MAX_LIMIT;

  const page = parseIntParam(query.page, 'page') ?? 1;
  let limit = parseIntParam(query.limit, 'limit') ?? defaultLimit;
  if (limit > maxLimit) limit = maxLimit; // plafond : on ramène, on ne rejette pas

  const offset = (page - 1) * limit;
  // `page` étant un entier sûr et `limit` ≤ 200, `offset` ne dépasse 2^53 que pour un
  // `page` absurde (~4,5e13) : garde-fou pour tenir la garantie « toujours sûr ».
  if (!Number.isSafeInteger(offset)) {
    throw new PaginationError('Paramètre de pagination invalide : « page » hors limites');
  }

  return { page, limit, offset };
}

module.exports = { parsePagination, PaginationError, DEFAULT_LIMIT, MAX_LIMIT };
