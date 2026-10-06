const { guardSend } = require('./sendGuard');
const { getDb } = require('../db/schema');
const { isTemplateRetired } = require('../config/whatsappPolicy');

const WASEL_BASE_URL = 'https://wasel-api.wasel.ma/external/v1';

// WhatsApp/Meta rejette les variables de template contenant certains caractères
// (retours à la ligne, tabulations, 4+ espaces consécutifs) ou trop longues.
// On normalise systématiquement chaque variable avant l'envoi, plutôt que de
// deviner au cas par cas quel appel précis posera problème.
function sanitizeTemplateVariable(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  str = str.replace(/[\r\n\t]/g, ' ');   // retours à la ligne / tabulations → espace
  str = str.replace(/ {2,}/g, ' ');       // espaces multiples → un seul
  str = str.replace(/[\[\]]/g, '');       // crochets (ex: "[TEST]") non supportés par Meta
  str = str.trim();
  if (str.length > 60) str = str.slice(0, 57) + '...'; // limite raisonnable, évite un rejet pour longueur excessive
  return str;
}

// Cœur de l'envoi, sans aucune interaction DB — utilisé à la fois par sendWhatsAppTemplate
// (ci-dessous, qui journalise un échec réel dans whatsapp_send_failures) et par le cron de
// retry (jobs/whatsappRetry.js, qui met à jour lui-même la ligne existante plutôt que d'en
// recréer une via sendWhatsAppTemplate — voir la note sur ce module). Ne lance jamais
// d'erreur. `skipped:true` distingue un envoi jamais tenté (config/donnée manquante, pas un
// échec réseau/API) d'un vrai échec d'envoi — seul ce dernier doit être journalisé/retenté.
async function sendWhatsAppTemplateRaw(templateName, phone, variables) {
  // Garde d'envoi (opt-in, NOTIFICATIONS_LIVE=1) : avant tout appel réseau.
  if (!guardSend('whatsapp', `template=${templateName}`)) return { ok: false, skipped: true, guarded: true };
  // Politique d'envoi (chantier 2, config/whatsappPolicy.js) : modèle retiré → jamais envoyé,
  // ni journalisé comme échec (skipped), quel que soit l'appelant (route, cron ou relance).
  if (isTemplateRetired(templateName)) {
    console.warn(`[wasel] Modèle retiré par la politique d'envoi — envoi refusé (template=${templateName})`);
    return { ok: false, skipped: true, retired: true };
  }
  const apiKey = process.env.WASEL_API_KEY;
  if (!apiKey) {
    console.warn(`[wasel] WASEL_API_KEY non configurée — envoi ignoré (template=${templateName})`);
    return { ok: false, skipped: true };
  }
  if (!phone || typeof phone !== 'string' || !phone.trim()) {
    console.warn(`[wasel] Numéro de téléphone manquant ou invalide — envoi ignoré (template=${templateName})`);
    return { ok: false, skipped: true };
  }

  try {
    const response = await fetch(`${WASEL_BASE_URL}/send-template`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        phone: phone.trim(),
        template_name: templateName,
        lang: 'fr',
        variables: (variables || []).map(sanitizeTemplateVariable),
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMessage = `HTTP ${response.status} — ${JSON.stringify(data)}`;
      console.error(`[wasel] Échec envoi template "${templateName}" — HTTP ${response.status}`, JSON.stringify(data, null, 2));
      return { ok: false, skipped: false, errorMessage };
    }

    return { ok: true };
  } catch (err) {
    console.error(`[wasel] Erreur réseau lors de l'envoi du template "${templateName}"`, err.message);
    return { ok: false, skipped: false, errorMessage: err.message };
  }
}

// Best-effort : journalise un échec d'envoi réel dans whatsapp_send_failures pour visibilité
// admin (GET /users/admin/whatsapp-failures) + retry automatique (jobs/whatsappRetry.js). Une
// erreur ici ne doit jamais remonter à l'appelant de sendWhatsAppTemplate — même contrat que
// l'échec WhatsApp lui-même (voir plus bas).
async function logSendFailure(db, templateName, phone, variables, errorMessage) {
  try {
    await db.query(
      `INSERT INTO whatsapp_send_failures (template_name, phone, variables, error_message) VALUES ($1, $2, $3, $4)`,
      [templateName, phone, JSON.stringify(variables || []), errorMessage]
    );
  } catch (err) {
    console.error(`[wasel] Échec enregistrement de l'échec en base (template="${templateName}")`, err.message);
  }
}

// Envoie un message WhatsApp via un template Wasel. Ne lance jamais d'erreur vers
// l'appelant — un échec d'envoi ne doit jamais faire échouer l'action métier associée
// (embauche, transition de statut, etc). Renvoie true en cas de succès, false sinon.
// `db` par défaut sur le pool partagé (voir utils/ticketReference.js pour le même pattern) —
// aucun appelant existant n'a besoin de le fournir explicitement.
// Journal des envois RÉUSSIS (whatsapp_send_log) : modèle, mission, statut. Aucun numéro ni contenu.
// Best-effort : une erreur d'écriture n'interrompt jamais l'envoi.
async function logSendSuccess(db, templateName, missionId) {
  try {
    await db.query(
      `INSERT INTO whatsapp_send_log (template_name, mission_id, status) VALUES ($1, $2, 'sent')`,
      [templateName, missionId || null]
    );
  } catch (err) {
    console.error(`[wasel] Échec journalisation du succès (template="${templateName}")`, err.message);
  }
}

async function sendWhatsAppTemplate(templateName, phone, variables, db = getDb(), meta = {}) {
  const result = await sendWhatsAppTemplateRaw(templateName, phone, variables);
  if (!result.ok && !result.skipped) {
    await logSendFailure(db, templateName, phone.trim(), variables, result.errorMessage);
  }
  if (result.ok) await logSendSuccess(db, templateName, meta.missionId);
  return result.ok;
}

module.exports = { sendWhatsAppTemplate, sendWhatsAppTemplateRaw };
