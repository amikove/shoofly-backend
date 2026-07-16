// Centralise les noms de templates WhatsApp (Wasel/Meta) approuvés pour un flux donné.
// La plupart des appels du projet utilisent encore un nom de template en dur (ex: 'ticket_urgent_ouvert'
// réutilisé comme test technique tant qu'aucun template dédié n'est approuvé côté Wasel) — ce fichier
// ne remplace pas encore ces appels, il prépare seulement les entrées dédiées à venir.
module.exports = {
  // Non utilisée pour l'instant — le flux de modification de mission (PUT /missions/:id sur une
  // mission 'assigned') envoie encore 'ticket_urgent_ouvert' en dur. Remplacer 'A_REMPLIR_...' par
  // le nom réel une fois ce template créé et approuvé chez Wasel, puis basculer l'appel dans
  // src/routes/missions.js sur `waselTemplates.edit_request_pending.template_name`.
  // Variables idéales (dans l'ordre) :
  //   {{1}} référence/titre de la mission concernée
  //   {{2}} résumé du changement proposé (ex: "nouvelle date : 12/08 14h")
  //   {{3}} délai de réponse restant (ex: "30min" ou "2h")
  edit_request_pending: { template_name: 'A_REMPLIR_edit_request_pending' },
};
