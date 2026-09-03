// Valeurs par défaut des réglages configurables (table `settings`, colonne `value` en TEXT).
//
// Source UNIQUE — avant ce fichier, ces valeurs n'existaient que sous forme d'instructions SQL
// littérales dans le bloc `INSERT INTO settings` de db/schema.js. Toute personne voulant les
// consulter ailleurs (ex: une future route de réinitialisation admin) devait recopier la liste à
// la main, avec le risque de divergence que ça implique dès que l'une des deux copies est mise à
// jour sans l'autre. Désormais schema.js (seed initial d'une base neuve) ET
// GET /admin/settings/defaults (routes/users.js, réinitialisation admin) importent ce même objet
// — un seul endroit à modifier pour changer un défaut, jamais deux listes à resynchroniser.
//
// Les valeurs ci-dessous sont les valeurs EFFECTIVES actuelles (post-migrations) : quand un défaut
// a changé de sens après coup (voir les 2 `UPDATE settings ... WHERE value='ancien défaut'` juste
// après le bloc INSERT dans schema.js — reminder_before_mission_minutes_late 30→45,
// transfer_cooldown_before_hours 2→3), c'est la valeur la plus récente qui figure ici. Ces 2
// lignes UPDATE restent nécessaires pour les bases déjà provisionnées avant ce changement — ne pas
// les supprimer, elles ne font simplement plus rien sur une base neuve puisque l'INSERT écrit déjà
// directement la bonne valeur.
module.exports = {
  commission: '0.20',
  min_price: '80',
  five_star_bonus_active: 'false',
  five_star_bonus_percent: '10',
  urgency_fee: '0.30',
  accept_delay: '15',
  transfer_grace_minutes_queue: '45',
  transfer_grace_minutes_other: '60',
  candidate_window_minutes_fast: '10',
  candidate_window_minutes_choose_queue: '5',
  candidate_window_minutes_choose_other: '10',
  mission_edit_approval_minutes: '120',
  mission_edit_approval_minutes_urgent: '30',
  mission_edit_urgent_threshold_hours: '4',
  client_validation_hours: '12',
  schedule_conflict_window_hours: '4',
  transfer_cooldown_hours: '4',
  transfer_cooldown_before_hours: '3',
  abandon_during_mission_cooldown_hours: '48',
  stale_mission_hours: '12',
  stale_mission_min_lead_hours: '4',
  mission_overdue_verification_hours: '24',
  late_start_alert_window_minutes: '30',
  late_start_auto_transfer_minutes: '60',
  reminder_before_mission_minutes_early: '120',
  reminder_before_mission_minutes_late: '45',
  refund_partial_threshold_hours: '2',
  refund_partial_rate: '0.5',
  new_oeil_mission_threshold: '10',
  reactivation_default_score: '70',
  ticket_auto_resolve_hours: '72',
  response_time_max_valid_minutes: '1440',
  response_time_min_turns: '3',
  dashboard_stuck_pending_hours: '24',
  dashboard_low_reliability_threshold: '70',
  candidate_confirmation_minutes: '10',
  presence_confirmation_deadline_minutes: '120',
  presence_confirmation_deadline_minutes_sameday: '45',
  candidate_batch_size: '10',
  candidate_tiebreak_window_minutes: '5',
  // PROMPT 2 (2026-08-17) — plafonne le nombre de lots successifs qu'advanceCandidateCascade
  // tire avant de passer en recherche élargie (is_urgent=true), au lieu d'un tirage illimité tant
  // que mission_interests n'est pas épuisé. Voir schema.js (missions.batch_wave_count).
  candidate_batch_max_waves: '2',
  payment_attempt_abandoned_minutes: '30',
  urgent_mission_whatsapp_batch_size: '10',
  urgent_mission_whatsapp_batch_delay_minutes: '30',
  candidature_whatsapp_seuil_count: '3',
  candidature_whatsapp_seuil_minutes: '60',
  whatsapp_retry_max_attempts: '3',
  no_show_h30_penalty_points: '-20',
  no_show_h30_debit_cap_mad: '100',
  transfer_during_no_replacement_penalty_points: '-70',
  transfer_during_no_replacement_debit_cap_mad: '100',
  transfer_before_no_replacement_penalty_points: '-10',
  transfer_before_replacement_bonus_points: '5',
  late_cancel_penalty_tier1_points: '-15',
  late_cancel_penalty_tier2_points: '-35',
  late_cancel_penalty_tier3_points: '-50',
  late_cancel_penalty_tier1_threshold_hours: '24',
  late_cancel_penalty_tier2_threshold_hours: '2',
  // Palier 1 (préavis >= 24h) rendu délibérément inatteignable (PROMPT 1 point 5, 2026-08-17,
  // section 0/B4 : "toute annulation hors motif légitime ET moins de 24h doit être pénalisée" —
  // interprété comme : un préavis de 24h ou plus n'est plus pénalisé du tout). Réglage plutôt que
  // constante figée dans le code : un admin peut réactiver ce palier depuis l'écran Paramètres,
  // sans déploiement, si l'interprétation s'avérait fausse — voir computeLatePenalty, utils/reliabilityScore.js.
  late_cancel_penalty_tier1_enabled: 'false',
  presence_confirmation_deadline_minutes_h45: '15',
  password_reset_token_expiry_hours: '1',
  // PROMPT 2 (2026-08-17) — détection d'abandon sans GPS : fréquence de la demande de photo
  // (sans visage) pendant qu'une mission est 'active'. Voir schema.js
  // (missions.activity_photo_next_due_at), routes/missions.js et routes/media.js.
  activity_photo_interval_minutes: '45',
  // PROMPT 5 (2026-08-18) — rappel intermédiaire client pendant la fenêtre de validation
  // (client_validation_hours=12 par défaut) : envoyé à H+6, à mi-parcours avant l'auto-validation
  // silencieuse. Voir jobs/autoValidateMissions.js:runValidationReminders.
  client_validation_reminder_hours: '6',
  // Relance WhatsApp des candidatures non choisies par le client — 1er renvoi
  // candidature_relance_first_after_minutes après la notification initiale
  // (candidature_whatsapp_sent_at), puis tous les candidature_relance_interval_minutes. Si la
  // mission passe sous candidature_relance_imminent_threshold_minutes avant scheduled_at, la
  // relance WhatsApp est remplacée par une alerte admin (onglet "Missions proches sans
  // validation") — voir cron dédié, index.js.
  candidature_relance_first_after_minutes: '60',
  candidature_relance_interval_minutes: '120',
  candidature_relance_imminent_threshold_minutes: '120',
  // Relance par email si une notification WhatsApp à délai court (cascade candidat ~10min,
  // confirmation de présence H-45) reste non lue ce délai après l'envoi — voir cron dédié,
  // index.js, et services/email.js.
  unread_whatsapp_email_fallback_minutes: '5',
  // ── Anti-fraude (routes/antiFraud.js) ────────────────────────────────────────────────────
  // Fenêtres de détection du moteur de score de risque (analyzeUser) et de l'écran admin
  // Anti-fraude. Défauts = valeurs exactes précédemment codées en dur (audit
  // rapport-audit-valeurs-temps-hardcodees-2026-09-01.md, §A) : aucun changement de
  // comportement tant qu'un admin ne les modifie pas. Les seuils de COMPTAGE (>= 3, >= 2)
  // restent dans l'objet RULES, hors périmètre. Regroupement justifié dans
  // rapport-chantier-antifraude-fenetres-2026-09-03.md.
  //
  // -- Scoring d'un Œil --
  fraud_oeil_cancel_lookback_days: '7',        // :138 annulations répétées (seuil RULES >= 3)
  fraud_oeil_nomedia_lookback_days: '30',      // :150 missions terminées sans média (seuil RULES >= 2)
  fraud_oeil_too_fast_lookback_days: '30',     // :160 fenêtre des missions terminées trop vite
  fraud_oeil_too_fast_seconds: '300',          // :161 seuil "terminée en moins de 5 min" (completed_at - started_at)
  // -- Manipulation de note : UNE clé (les 2 requêtes pivotent sur le même instant) --
  fraud_rating_spike_window_hours: '48',       // :173 (5★ récents) + :179 (moyenne d'avant)
  // -- Scoring d'un client --
  fraud_client_cancel_lookback_days: '30',     // :205 annulations abusives (seuil RULES >= 3)
  fraud_client_refund_lookback_days: '14',     // :216 demandes de remboursement répétées (seuil RULES >= 2)
  fraud_client_fake_mission_lookback_days: '30', // :228 fenêtre des missions fictives
  fraud_client_fake_mission_seconds: '600',    // :229 seuil "acceptée puis annulée en moins de 10 min" (cancelled_at - created_at)
  // -- Scan de la messagerie (score de risque tous rôles) --
  fraud_message_scan_lookback_days: '7',       // :256 ancienneté max des messages scannés (coordonnées directes)
  // -- Écran admin Anti-fraude (GET /anti-fraud/dashboard) : affichage uniquement --
  fraud_dashboard_recent_days: '7',            // :284 liste missions sans média + :303 liste messages suspects + :310 compteur no_media_missions
  fraud_dashboard_cancellations_days: '30',    // :309 compteur cancellations_30d des stats
};
