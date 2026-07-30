// Centralise les noms de templates WhatsApp (Wasel/Meta) utilisés par src/services/wasel.js.
//
// Filtrage 2026-07-25 : sur les 44 événements candidats catalogués (audit 2026-07-23), seuls
// 21 envoyaient réellement un WhatsApp — critère unique retenu : "une action est attendue
// rapidement" de la part du destinataire (+ 1 cas particulier de blocage total, voir
// account_blocked_fraud_oeil). Tout le reste reste en notification in-app uniquement. Un 22e
// (mission_without_oeil_admin) a été ajouté après coup, hors de ce filtrage : implémentation
// d'un TODO WhatsApp préexistant, voir sa note ci-dessous — pas un nouvel événement candidat.
//
// Chaque événement gardé a désormais SON PROPRE nom de template dédié (ci-dessous) — les 2
// templates génériques de test technique ('ticket_urgent_ouvert', 'nouvelle_verification_
// identite') qui servaient jusqu'ici à tout le monde ne sont plus référencés nulle part dans
// le code. IMPORTANT : aucun de ces templates dédiés n'existe encore réellement côté Wasel —
// leur création sur app.wasel.ma/templates reste une action manuelle de l'utilisateur, hors de
// ce chantier. Tant qu'un template n'est pas créé et approuvé côté Wasel, l'appel correspondant
// échouera en pratique (HTTP 400/404 selon l'API Wasel) — sendWhatsAppTemplate avale déjà cet
// échec sans jamais faire remonter d'erreur à l'appelant (voir services/wasel.js).

module.exports = {
  // PUT /missions/:id sur une mission 'assigned' — le client propose une modification,
  // l'Œil assigné est notifié par WhatsApp qu'il a un délai pour répondre.
  edit_proposed_to_oeil: {
    template_name: 'modification_proposee_oeil',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé de contexte ("Modification proposée par le client")',
  },

  // POST /missions/edit-requests/:id/approve — l'Œil accepte la modification proposée,
  // le client est notifié par WhatsApp que sa demande a été acceptée.
  edit_request_approved: {
    template_name: 'modification_acceptee_client',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé de contexte ("Modification acceptée par l\'Œil")',
  },

  // POST /missions/edit-requests/:id/reject — l'Œil refuse la modification proposée,
  // la mission repart en recherche sans pénalité, le client est notifié par WhatsApp.
  edit_request_rejected: {
    template_name: 'modification_refusee_client',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé de contexte ("Mission remise en recherche")',
  },

  // checkMissionEditRequestExpiry (job planifié) — la demande de modification a expiré sans
  // réponse de l'Œil, la mission repart en recherche, le client est notifié par WhatsApp.
  edit_request_expired: {
    template_name: 'modification_expiree_client',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé de contexte ("Mission remise en recherche")',
  },

  // PATCH /missions/:id (status='completed') — l'Œil marque la mission comme terminée,
  // le client est notifié par WhatsApp qu'il a 12h pour réclamer si nécessaire.
  mission_completed_client: {
    template_name: 'mission_terminee_a_valider',
    variableCount: 2,
    note: '{{1}} nom de l\'Œil, {{2}} titre de la mission',
  },

  // POST /missions/:id/interest — un Œil manifeste son intérêt (candidature). PAS un envoi par
  // candidature individuelle : voir la règle de seuil (candidature_whatsapp_seuil_count/
  // _minutes, missions.js + index.js) — un seul WhatsApp au client par mission, déclenché dès
  // que le seuil de candidatures est atteint, ou à défaut après le délai configuré.
  oeil_applied: {
    template_name: 'nouvelle_candidature_oeil',
    variableCount: 2,
    note: '{{1}} nombre de candidatures reçues, {{2}} titre de la mission',
  },

  // advanceCandidateCascade (routes/missions.js) — le candidat le mieux classé de
  // mission_interests est sollicité pour confirmer sa disponibilité avant assignation.
  candidate_confirmation_request: {
    template_name: 'confirmez_disponibilite_candidat',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} délai de confirmation en minutes',
  },

  // PUT /users/admin/:id/toggle-active (désactivation) — l'Œil désactivé est notifié que
  // sa mission a été réattribuée automatiquement, sans ambiguïté sur l'absence de pénalité.
  // Déclencheur actuel : is_active=false via cette route précise. Si le chantier séparé
  // "refonte suspension" bascule cette route sur is_suspended, ce template reste valable
  // sans changement — seul le déclencheur technique changera, pas l'événement métier.
  oeil_reassigned_no_penalty: {
    template_name: 'mission_reattribuee_sans_penalite',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé fixe ("Aucune pénalité")',
  },

  // Cron J-1 20h (index.js) — demande de confirmation active de présence pour une mission
  // prévue demain.
  presence_confirmation_request_j1: {
    template_name: 'confirmez_presence_j1',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} heure limite de confirmation (ex: "22h00")',
  },

  // Cron H-2 (index.js) — même demande de confirmation active, cas mission assignée le jour
  // même (jamais passée par le rappel J-1), délai raccourci dédié.
  presence_confirmation_request_sameday: {
    template_name: 'confirmez_presence_jour_meme',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} heure limite de confirmation (ex: "14h45")',
  },

  // checkPresenceConfirmationDeadlines (job planifié, routes/missions.js) — délai de
  // confirmation de présence expiré sans réponse, réattribution automatique lancée,
  // sans ambiguïté sur l'absence de pénalité.
  presence_not_confirmed_no_penalty: {
    template_name: 'presence_non_confirmee_reattribue',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé fixe ("Aucune pénalité")',
  },

  // hireOeilCore — le client embauche un Œil pour la mission, l'Œil embauché est notifié
  // par WhatsApp avec le nom du client qui l'a choisi.
  oeil_hired: {
    template_name: 'candidat_selectionne',
    variableCount: 1,
    note: '{{1}} nom du client qui a embauché l\'Œil',
  },

  // sendUrgentWhatsAppWave (routes/missions.js), appelée depuis notifyNewMission à la création
  // d'une mission is_urgent=true (POST /missions direct ou paiement PayZone confirmé) ET par le
  // cron de vagues suivantes (index.js) — mécanisme de vagues déjà en place, inchangé par cette
  // session (seul le nom de template est mis à jour ici).
  urgent_mission_whatsapp_wave: {
    template_name: 'nouvelle_mission_urgente',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} prix affiché (ex: "350 MAD")',
  },

  // POST /:id/accept (acceptation directe par l'Œil) et POST /:id/assign-admin (affectation
  // manuelle par un admin) — le client est notifié qu'un Œil est désormais assigné à sa
  // mission. Ne couvre PAS la résolution de la cascade de confirmation par lot (index.js,
  // "remplaçant trouvé") : ce cas précis a été jugé ne pas nécessiter de WhatsApp (le client a
  // déjà été informé de la recherche en cours, aucune action rapide n'est attendue de sa part).
  oeil_assigned_client: {
    template_name: 'oeil_assigne_mission',
    variableCount: 2,
    note: '{{1}} nom de l\'Œil assigné, {{2}} titre de la mission',
  },

  // checkTransferDeadlines (routes/missions.js) — aucun remplaçant trouvé avant expiration du
  // délai de transfert, mission annulée et remboursement intégral effectué.
  mission_cancelled_no_replacement_client: {
    template_name: 'mission_annulee_sans_remplacant',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} montant remboursé (ex: "350 MAD")',
  },

  // POST /missions/:id/status (status='cancelled') — mission annulée par le client ou par un
  // admin (jamais par l'Œil lui-même sur sa propre mission — aucun intérêt à s'auto-notifier),
  // l'Œil assigné est notifié. 3 branches de la route concernées (remboursement personnalisé
  // admin, annulation imputée au client, annulation admin sans faute du client) — même
  // template, libellé de contexte {{2}} différent selon le cas.
  mission_cancelled_oeil: {
    template_name: 'mission_annulee_oeil',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} libellé de contexte ("Annulée par le client" / "Annulée par l\'administrateur")',
  },

  // POST /:id/assign-admin — l'Œil est notifié qu'un admin l'a assigné manuellement à cette
  // mission (distinct de oeil_assigned_client ci-dessus, qui notifie le CLIENT sur cette même
  // route).
  mission_assigned_by_admin_oeil: {
    template_name: 'mission_assignee_admin',
    variableCount: 1,
    note: '{{1}} titre de la mission',
  },

  // Cron H-45min (index.js, "Rappels avant mission") — anciennement un rappel purement
  // informatif ("rappel_avant_mission", #30 du catalogue) ; renommé et repris ici comme VRAIE
  // demande de confirmation active (chantier "confirmation H-2/H-45"), au même titre que
  // presence_confirmation_request_j1/_sameday ci-dessus. Seul appelant restant après ce
  // chantier (l'ancien appel H-2 informatif a été fusionné dans la branche active H-2 qui
  // utilise déjà presence_confirmation_request_sameday).
  presence_confirmation_request_h45: {
    template_name: 'confirmez_presence_h45',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} heure limite de confirmation (ex: "18h30")',
  },

  // Cron "Alertes H et H+30" (index.js) — la mission aurait dû commencer, l'Œil est alerté.
  // Ne couvre pas la branche H+30 (transfert automatique + pénalité) : non retenue dans la
  // liste WhatsApp.
  mission_late_alert_oeil: {
    template_name: 'mission_alerte_retard',
    variableCount: 1,
    note: '{{1}} titre de la mission',
  },

  // POST /anti-fraud/block/:userId — cas particulier : blocage total (is_active=false), seul
  // canal encore capable d'atteindre l'utilisateur puisqu'il ne peut plus se connecter à
  // l'app. Ne concerne QUE cette route précise, jamais PUT /users/admin/:id/toggle-active
  // (désactivation générique — accès conservé dans ce cas, aucun WhatsApp).
  account_blocked_fraud_oeil: {
    template_name: 'compte_suspendu_fraude',
    variableCount: 1,
    note: '{{1}} raison du blocage (ou libellé par défaut si non précisée)',
  },

  // POST /tickets (is_urgent=true, category=URGENT_CATEGORY) — le véritable événement
  // "ticket urgent ouvert", notifié aux admins. Sans rapport avec l'ancien détournement du
  // template générique 'ticket_urgent_ouvert' par 13 autres événements (tous corrigés dans
  // cette même session) — c'est ici son unique et véritable usage désormais.
  urgent_ticket_admin: {
    template_name: 'ticket_urgent_admin',
    variableCount: 2,
    note: '{{1}} référence du ticket (ex: "TKT-A2B3C4"), {{2}} sous-catégorie ou catégorie',
  },

  // Cron "Missions jamais assignées" (index.js) — mission en attente depuis plus de
  // stale_mission_hours sans Œil trouvé, les admins sont alertés (in-app existait déjà, le
  // TODO WhatsApp laissé dans le code est désormais réalisé).
  mission_without_oeil_admin: {
    template_name: 'mission_sans_oeil_admin',
    variableCount: 1,
    note: '{{1}} titre de la mission',
  },

  // Cron rappel client J-1 20h (index.js) — rappel purement informatif envoyé au CLIENT,
  // aucune confirmation attendue (contrairement aux templates presence_confirmation_request_*
  // ci-dessus, qui ciblent l'Œil avec une deadline de réponse). Même horaire que le cron de
  // confirmation Œil, mais garde anti-doublon et déclenchement indépendants.
  mission_reminder_j1_client: {
    template_name: 'rappel_mission_j1_client',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} heure de la mission (ex: "14h30")',
  },

  // Cron rappel client H-2 (index.js) — second palier informatif, cron dédié distinct du H-2/
  // H-45 Œil ci-dessus (qui pose une deadline de confirmation active — mécanique différente,
  // volontairement pas réutilisée pour le client).
  mission_reminder_h2_client: {
    template_name: 'rappel_mission_h2_client',
    variableCount: 2,
    note: '{{1}} titre de la mission, {{2}} délai en minutes avant la mission (ex: "120")',
  },
};
