// Catégorie 7 — setup 7.1 (normal) et 7.2 (urgent), résolution attendue au cron horaire 20h00.
const { api, setSetting } = require('./lib');
const accounts = require('./accounts_s.json');
const fs = require('fs');
const path = require('path');

async function main() {
  await setSetting('ticket_auto_resolve_hours', '0.4', accounts.admin.token); // ~24min — passe avant 20h00

  const state = {};

  // 7.1 — ticket normal
  {
    const rc = await api('POST', '/tickets', { category: 'application', initial_message: 'Question générale scénario 7.1' }, accounts.client.token);
    if (rc.status !== 201) throw new Error('7.1 create ticket failed: ' + JSON.stringify(rc));
    const rm = await api('POST', `/tickets/${rc.data.ticket.id}/messages`, { content: 'Réponse admin — scénario 7.1' }, accounts.admin.token);
    if (rm.status !== 201) throw new Error('7.1 admin reply failed: ' + JSON.stringify(rm));
    state.s71 = { ticketId: rc.data.ticket.id, reference: rc.data.ticket.reference };
  }

  // 7.2 — ticket urgent (catégorie 'urgence' → is_urgent=true automatique)
  {
    const rc = await api('POST', '/tickets', { category: 'urgence', initial_message: 'Urgence scénario 7.2' }, accounts.client.token);
    if (rc.status !== 201) throw new Error('7.2 create ticket failed: ' + JSON.stringify(rc));
    if (rc.data.ticket.is_urgent !== true) throw new Error('7.2 ticket pas marqué urgent: ' + JSON.stringify(rc.data.ticket));
    const rm = await api('POST', `/tickets/${rc.data.ticket.id}/messages`, { content: 'Réponse admin — scénario 7.2' }, accounts.admin.token);
    if (rm.status !== 201) throw new Error('7.2 admin reply failed: ' + JSON.stringify(rm));
    state.s72 = { ticketId: rc.data.ticket.id, reference: rc.data.ticket.reference };
  }

  fs.writeFileSync(path.join(__dirname, 'ticket_state.json'), JSON.stringify(state, null, 2));
  console.log('OK — tickets 7.1/7.2 créés:', JSON.stringify(state, null, 2));
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
