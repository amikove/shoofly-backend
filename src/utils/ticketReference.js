// Extrait de routes/tickets.js pour être réutilisable ailleurs (ex: création d'un ticket
// litige directement depuis routes/missions.js, flux "Demander assistance") sans dupliquer
// la génération de référence. Comportement strictement inchangé.
const { getDb } = require('../db/schema');

const REFERENCE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans caractères ambigus (0/O, 1/I)

function randomReference() {
  let ref = '';
  for (let i = 0; i < 6; i++) ref += REFERENCE_CHARS[Math.floor(Math.random() * REFERENCE_CHARS.length)];
  return `TKT-${ref}`;
}

async function generateUniqueReference(db = getDb()) {
  for (let i = 0; i < 5; i++) {
    const ref = randomReference();
    const { rows } = await db.query('SELECT 1 FROM support_tickets WHERE reference=$1', [ref]);
    if (!rows.length) return ref;
  }
  throw new Error('Impossible de générer une référence de ticket unique');
}

module.exports = { randomReference, generateUniqueReference };
