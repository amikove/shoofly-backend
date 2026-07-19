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

  // advanceCandidateCascade (routes/missions.js) — le candidat le mieux classé de
  // mission_interests est sollicité pour confirmer sa disponibilité avant assignation.
  candidate_confirmation_request: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} délai de confirmation en minutes',
  },

  // POST /:id/candidate-confirm — un candidat sollicité par la cascade a confirmé sa
  // disponibilité et a été assigné, le client est notifié qu'un remplaçant a été trouvé.
  replacement_confirmed_client: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé fixe ("Remplaçant trouvé")',
  },

  // advanceCandidateCascade — liste de candidats initiale épuisée (tous refusés ou sans
  // réponse), la mission passe is_urgent=true et devient visible publiquement ; le client
  // est informé à titre de transparence uniquement (jamais sollicité pour un choix).
  mission_urgent_broadened: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé fixe ("Recherche élargie")',
  },

  // PUT /users/admin/:id/toggle-active (désactivation) — l'Œil désactivé est notifié que
  // sa mission a été réattribuée automatiquement, sans ambiguïté sur l'absence de pénalité.
  oeil_reassigned_no_penalty: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé fixe ("Aucune pénalité")',
  },

  // Cron J-1 20h (index.js) — demande de confirmation active de présence pour une mission
  // prévue demain. Envoi one-way (pas de bouton de réponse rapide géré : le template partagé
  // 'ticket_urgent_ouvert' n'a pas de quick-reply configuré côté Meta, et aucun webhook de
  // réception de réponse WhatsApp n'existe dans ce backend — voir rapport de session, point 2).
  presence_confirmation_request_j1: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} heure limite de confirmation (ex: "22h00")',
  },

  // Cron H-2 (index.js) — même demande de confirmation active, cas mission assignée le jour
  // même (jamais passée par le rappel J-1), délai raccourci dédié.
  presence_confirmation_request_sameday: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} heure limite de confirmation (ex: "14h45")',
  },

  // checkPresenceConfirmationDeadlines (job planifié, routes/missions.js) — délai de
  // confirmation de présence expiré sans réponse, réattribution automatique lancée,
  // sans ambiguïté sur l'absence de pénalité (même esprit que oeil_reassigned_no_penalty).
  // variableCount=2 corrigé empiriquement (audit session confirmation de présence,
  // 2026-07-19) : le template Wasel réel 'ticket_urgent_ouvert' exige TOUJOURS exactement 2
  // variables ({{1}},{{2}}) quel que soit l'appelant — un appel à 1 seule variable échoue en
  // HTTP 400 "Template variable count mismatch", indépendamment du problème de compte Wasel/
  // Meta déjà connu (OAuthException/502). oeil_reassigned_no_penalty, replacement_confirmed_
  // client et mission_urgent_broadened ci-dessus déclaraient le même défaut (variableCount=1,
  // un seul argument au site d'appel) — corrigé le même jour (audit variableCount, 2026-07-19).
  presence_not_confirmed_no_penalty: {
    template_name: 'ticket_urgent_ouvert',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé fixe ("Aucune pénalité")',
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
