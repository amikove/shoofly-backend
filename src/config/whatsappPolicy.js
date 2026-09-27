// Politique d'envoi WhatsApp — chantier 2 (décisions BOSS du 2026-09-26).
//   A.  Œils : plus AUCUN WhatsApp (remplacé par notification in-app + push, déjà en place).
//   D3. Clients : plus aucun WhatsApp SAUF « des Œils ont postulé » (oeil_applied, seuil / repli).
//   D4. Relance des candidatures : notification in-app + push, plus de WhatsApp.
//   D6. Admins : inchangés.
//   D7. Blocage anti-fraude : plus de WhatsApp (tous rôles).
//
// Seuls les modèles ci-dessous peuvent encore partir. Garde centrale (services/wasel.js) : un
// modèle CONNU de config/waselTemplates.js mais absent de cette liste est refusé à l'envoi (et
// n'est plus retenté par jobs/whatsappRetry.js) — un appel réintroduit par erreur ne part pas.
// Ajouter un modèle ici est une décision produit, pas un détail technique.
const templates = require('./waselTemplates');

const ALLOWED_TEMPLATE_KEYS = [
  'oeil_applied',               // client — des Œils ont postulé (routes/missions.js + cron de repli, index.js)
  'urgent_ticket_admin',        // admin — ticket urgent (routes/tickets.js)
  'mission_without_oeil_admin', // admin — mission sans Œil depuis 12 h (index.js)
];

const ALLOWED_TEMPLATE_NAMES = new Set(ALLOWED_TEMPLATE_KEYS.map((k) => templates[k].template_name));
const RETIRED_TEMPLATE_NAMES = new Set(
  Object.values(templates).map((t) => t.template_name).filter((name) => !ALLOWED_TEMPLATE_NAMES.has(name))
);

function isTemplateRetired(templateName) {
  return RETIRED_TEMPLATE_NAMES.has(templateName);
}

module.exports = { ALLOWED_TEMPLATE_KEYS, ALLOWED_TEMPLATE_NAMES, RETIRED_TEMPLATE_NAMES, isTemplateRetired };
