// Politique d'envoi WhatsApp — chantier 2 (décisions BOSS du 2026-09-26).
//   A.  Œils : plus AUCUN WhatsApp (remplacé par notification in-app + push, déjà en place).
//   D3. Clients : plus aucun WhatsApp SAUF « des Œils ont postulé » (oeil_applied, seuil / repli).
//   D4. Relance des candidatures : notification in-app + push, plus de WhatsApp.
//   D6. Admins : inchangés.
//   D7. Blocage anti-fraude : plus de WhatsApp (tous rôles).
//   Lot 1 bis (décisions BOSS du 2026-09-27) : les 3 demandes de confirmation de présence de
//   l'Œil (J-1, H-2, H-45) repartent par WhatsApp, mais UNIQUEMENT en relance — si la présence
//   n'est toujours pas confirmée après un délai réglable (jobs/whatsappRelances.js). Tous les
//   autres WhatsApp Œil restent interdits.
//
// Seuls les modèles ci-dessous peuvent encore partir. Garde centrale (services/wasel.js) : un
// modèle CONNU de config/waselTemplates.js mais absent de cette liste est refusé à l'envoi (et
// n'est plus retenté par jobs/whatsappRetry.js) — un appel réintroduit par erreur ne part pas.
// Ajouter un modèle ici est une décision produit, pas un détail technique.
const templates = require('./waselTemplates');

const ALLOWED_TEMPLATE_KEYS = [
  'oeil_applied',               // client — des Œils ont postulé, en relance si la notification n'a pas été vue (jobs/whatsappRelances.js)
  'presence_confirmation_request_j1',      // Œil — relance J-1 si présence non confirmée (jobs/whatsappRelances.js)
  'presence_confirmation_request_sameday', // Œil — relance H-2 si présence non confirmée (jobs/whatsappRelances.js)
  'presence_confirmation_request_h45',     // Œil — relance H-45 si présence non confirmée (jobs/whatsappRelances.js)
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
