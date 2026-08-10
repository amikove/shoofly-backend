const RESEND_API_URL = 'https://api.resend.com/emails';
const EMAIL_FROM = 'SHOOFLY <noreply@shoofly.ma>';
const RESET_PASSWORD_URL_BASE = 'https://shoofly.ma/reset-password';

// Cœur de l'envoi, sans aucune connaissance du contenu métier — même découpage que
// sendWhatsAppTemplateRaw (services/wasel.js) : ne lance jamais d'erreur vers l'appelant,
// `skipped:true` distingue un envoi jamais tenté (clé absente) d'un vrai échec réseau/API.
// Utilise fetch nu plutôt que le SDK `resend` — même choix que wasel.js pour l'API Wasel,
// évite une dépendance supplémentaire pour un simple POST JSON.
async function sendEmailRaw(to, subject, html, text) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY non configurée — envoi ignoré (to=${to}, subject="${subject}")`);
    return { ok: false, skipped: true };
  }
  if (!to || typeof to !== 'string' || !to.trim()) {
    console.warn(`[email] Destinataire manquant ou invalide — envoi ignoré (subject="${subject}")`);
    return { ok: false, skipped: true };
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to.trim()],
        subject,
        html,
        text,
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      console.error(`[email] Échec envoi "${subject}" à ${to} — HTTP ${response.status}`, JSON.stringify(data));
      return { ok: false, skipped: false, errorMessage: `HTTP ${response.status} — ${JSON.stringify(data)}` };
    }

    return { ok: true };
  } catch (err) {
    console.error(`[email] Erreur réseau lors de l'envoi à ${to}`, err.message);
    return { ok: false, skipped: false, errorMessage: err.message };
  }
}

// POST /auth/forgot-password (routes/auth.js) — rawToken est le token EN CLAIR, seule occasion
// où il existe hors de la mémoire du process qui vient de le générer (jamais stocké en base,
// voir password_reset_token_hash dans db/schema.js). Lien codé en dur vers le domaine de
// production (jamais process.env.FRONTEND_URL, qui vaut localhost en dev) : la demande explicite
// est que ce lien soit correct dès aujourd'hui même si la page frontend n'existe pas encore.
async function sendPasswordResetEmail(toEmail, firstName, rawToken) {
  const link = `${RESET_PASSWORD_URL_BASE}?token=${rawToken}`;
  const subject = 'Réinitialisation de votre mot de passe SHOOFLY';
  const greeting = firstName ? `Bonjour ${firstName},` : 'Bonjour,';

  const text = `${greeting}

Vous avez demandé la réinitialisation de votre mot de passe SHOOFLY.

Cliquez sur le lien ci-dessous pour choisir un nouveau mot de passe (valable 1 heure) :
${link}

Si vous n'êtes pas à l'origine de cette demande, ignorez cet email — votre mot de passe restera inchangé.

L'équipe SHOOFLY`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <p>${greeting}</p>
      <p>Vous avez demandé la réinitialisation de votre mot de passe SHOOFLY.</p>
      <p>Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe (valable 1 heure) :</p>
      <p style="margin: 24px 0;">
        <a href="${link}" style="background:#111827;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">
          Réinitialiser mon mot de passe
        </a>
      </p>
      <p style="font-size: 13px; color: #555;">Ou copiez ce lien dans votre navigateur : <br>${link}</p>
      <p style="font-size: 13px; color: #555;">Si vous n'êtes pas à l'origine de cette demande, ignorez cet email — votre mot de passe restera inchangé.</p>
      <p>L'équipe SHOOFLY</p>
    </div>
  `;

  return sendEmailRaw(toEmail, subject, html, text);
}

module.exports = { sendEmailRaw, sendPasswordResetEmail };
