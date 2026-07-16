// Centralise les noms de templates WhatsApp (Wasel/Meta) utilisés par src/services/wasel.js.
// Les clés décrivent l'événement métier réel qui déclenche l'envoi, PAS le nom du template —
// plusieurs événements distincts réutilisent aujourd'hui le même template de test technique
// ('ticket_urgent_ouvert') tant qu'aucun template dédié n'est approuvé côté Wasel pour chacun.

module.exports = {
  // PUT /missions/:id sur une mission 'assigned' — le client propose une modification,
  // l'Œil assigné est notifié par WhatsApp qu'il a un délai pour répondre.
  edit_proposed_to_oeil: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé de contexte ("Modification proposée par le client")',
  },

  // POST /missions/edit-requests/:id/approve — l'Œil accepte la modification proposée,
  // le client est notifié par WhatsApp que sa demande a été acceptée.
  edit_request_approved: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé de contexte ("Modification acceptée par l\'Œil")',
  },

  // POST /missions/edit-requests/:id/reject — l'Œil refuse la modification proposée,
  // la mission repart en recherche sans pénalité, le client est notifié par WhatsApp.
  edit_request_rejected: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé de contexte ("Mission remise en recherche")',
  },

  // checkMissionEditRequestExpiry (job planifié) — la demande de modification a expiré sans
  // réponse de l'Œil, la mission repart en recherche, le client est notifié par WhatsApp.
  edit_request_expired: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé de contexte ("Mission remise en recherche")',
  },

  // PATCH /missions/:id (status='completed') — l'Œil marque la mission comme terminée,
  // le client est notifié par WhatsApp qu'il a 12h pour réclamer si nécessaire.
  mission_completed_client: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} nom de l\'Œil, {{2}} titre de la mission',
  },

  // POST /missions/:id/interest — un Œil manifeste son intérêt (candidature) pour une mission,
  // le client est notifié par WhatsApp (gratuit s'il a initié la conversation via wa.me).
  oeil_applied: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} libellé fixe ("Un Œil"), {{2}} titre de la mission',
  },

  // hireOeilCore — le client embauche un Œil pour la mission, l'Œil embauché est notifié
  // par WhatsApp avec le nom du client qui l'a choisi.
  oeil_hired: {
    template_name: 'nouvelle_verification_identite',
    variableCount: 1,
    note: '{{1}} nom du client qui a embauché l\'Œil',
  },

  // ── Entrées préparées mais non utilisées (templates dédiés pas encore approuvés côté Wasel) ──

  // Non utilisée pour l'instant — le flux de modification de mission (PUT /missions/:id sur une
  // mission 'assigned') envoie encore 'ticket_urgent_ouvert' en dur (voir edit_proposed_to_oeil
  // ci-dessus). Remplacer 'A_REMPLIR_...' par le nom réel une fois ce template créé et approuvé
  // chez Wasel, puis basculer l'appel dans src/routes/missions.js sur
  // `waselTemplates.edit_request_pending.template_name`.
  // Variables idéales (dans l'ordre) :
  //   {{1}} référence/titre de la mission concernée
  //   {{2}} résumé du changement proposé (ex: "nouvelle date : 12/08 14h")
  //   {{3}} délai de réponse restant (ex: "30min" ou "2h")
  edit_request_pending: { template_name: 'A_REMPLIR_edit_request_pending' },
};
