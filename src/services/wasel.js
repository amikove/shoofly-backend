const WASEL_BASE_URL = 'https://wasel-api.wasel.ma/external/v1';

// TEMP — audit technique en cours : buffer mémoire des derniers appels Wasel pour
// vérification via un endpoint admin, à retirer une fois la vérification terminée.
const _debugLastResults = [];
function _recordDebug(entry) {
  _debugLastResults.unshift({ ...entry, at: new Date().toISOString() });
  if (_debugLastResults.length > 20) _debugLastResults.pop();
}
function getDebugResults() { return _debugLastResults; }

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

  const phoneLast4 = phone.trim().slice(-4);

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
        variables: variables || [],
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      console.error(`[wasel] Échec envoi template "${templateName}" — HTTP ${response.status}`, data);
      _recordDebug({ templateName, phoneLast4, ok: false, status: response.status, data });
      return false;
    }

    _recordDebug({ templateName, phoneLast4, ok: true, status: response.status, data });
    return true;
  } catch (err) {
    console.error(`[wasel] Erreur réseau lors de l'envoi du template "${templateName}"`, err.message);
    _recordDebug({ templateName, phoneLast4, ok: false, error: err.message });
    return false;
  }
}

module.exports = { sendWhatsAppTemplate, getDebugResults };
