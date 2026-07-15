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

// Envoie un message WhatsApp via un template Wasel. Ne lance jamais d'erreur vers
// l'appelant — un échec d'envoi ne doit jamais faire échouer l'action métier associée
// (embauche, transition de statut, etc). Renvoie true en cas de succès, false sinon.
async function sendWhatsAppTemplate(templateName, phone, variables) {
  const apiKey = process.env.WASEL_API_KEY;
  if (!apiKey) {
    console.warn(`[wasel] WASEL_API_KEY non configurée — envoi ignoré (template=${templateName})`);
    return false;
  }
  if (!phone || typeof phone !== 'string' || !phone.trim()) {
    console.warn(`[wasel] Numéro de téléphone manquant ou invalide — envoi ignoré (template=${templateName})`);
    return false;
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
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      console.error(`[wasel] Échec envoi template "${templateName}" — HTTP ${response.status}`, JSON.stringify(data, null, 2));
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[wasel] Erreur réseau lors de l'envoi du template "${templateName}"`, err.message);
    return false;
  }
}

module.exports = { sendWhatsAppTemplate };
