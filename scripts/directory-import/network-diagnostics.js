// Diagnostic réseau partagé (Phase 5 quater/sexies, 2026-10-01/02) — déroule toute la chaîne
// error.cause d'un échec fetch() (undici/Node) pour exposer le vrai code (TLS/DNS/timeout/etc.) au
// lieu du message générique "fetch failed" qui masque tout. Utilisé par fetch-narsa-cct.js et
// overpass-client.js (santé + administrations).
function describeNetworkError(e) {
  const lines = [];
  let cur = e, depth = 0;
  while (cur && depth < 6) {
    const bits = [`${cur.name || 'Error'}: ${cur.message}`];
    if (cur.code) bits.push(`code=${cur.code}`);
    if (cur.errno) bits.push(`errno=${cur.errno}`);
    if (cur.syscall) bits.push(`syscall=${cur.syscall}`);
    if (cur.address) bits.push(`address=${cur.address}`);
    if (cur.port) bits.push(`port=${cur.port}`);
    lines.push(`  [profondeur ${depth}] ${bits.join(', ')}`);
    cur = cur.cause;
    depth++;
  }
  return lines.join('\n');
}

module.exports = { describeNetworkError };
