// Garde du script de seed (src/db/seed.js) : il TRUNCATE toutes les tables et recrée des comptes à
// mots de passe triviaux. Il ne tourne que si :
//   - NODE_ENV n'est pas « production » ;
//   - SHOOFLY_ALLOW_DESTRUCTIVE=1 est posé explicitement ;
//   - la base visée est locale (localhost, 127.0.0.1 ou ::1).
// Renvoie null si le seed est autorisé, sinon la raison du refus (message FR).
function seedGuardError(env, databaseUrl) {
  if (env.NODE_ENV === 'production') {
    return 'NODE_ENV=production : le seed ne doit jamais tourner en production.';
  }
  if (env.SHOOFLY_ALLOW_DESTRUCTIVE !== '1') {
    return 'Seed refusé : il efface toutes les tables. Posez SHOOFLY_ALLOW_DESTRUCTIVE=1 pour confirmer (base locale uniquement).';
  }
  let host;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return 'Seed refusé : DATABASE_URL absente ou illisible, impossible de vérifier que la base est locale.';
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'];
  if (!local.includes(host)) {
    return `Seed refusé : la base visée (${host}) n'est pas locale.`;
  }
  return null;
}

module.exports = { seedGuardError };
