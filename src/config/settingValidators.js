// Validation de type/plage des valeurs acceptées par PUT /admin/settings (routes/users.js).
//
// Contexte — audit exhaustif backend du 2026-09-05, §2.5 (majeur #2) : la route écrivait
// `String(req.body[key])` tel quel, sans aucun contrôle. Un `commission="abc"`, un
// `client_validation_hours="x"` ou un `five_star_bonus_percent="x"` (faute admin OU appel API
// direct) était stocké silencieusement puis : NaN de commission sur chaque nouvelle mission,
// 500 du cron d'auto-validation à chaque tick (`'x'::numeric`), ou bonus 5★ coupé sans erreur.
//
// Chaque règle est DÉDUITE de l'usage réel de la clé (pas de son nom) — voir la colonne
// "justification" du rapport de chantier
// (rapport-groupe1-validation-put-admin-settings-2026-09-05.md). Principe directeur : ne jamais
// rejeter une valeur de production légitime (les 79 valeurs réellement en base au 2026-09-05
// passent toutes — vérification rétroactive dans _audit/settings-validation-*.js). Les bornes
// hautes ne sont posées QUE là où le domaine est intrinsèquement borné (taux 0-1, pourcentage
// 0-100, score de fiabilité 0-100) ; ailleurs (durées, compteurs, plafonds MAD, fenêtres de
// détection) aucune borne haute — en poser une serait arbitraire. Le plancher générique est
// `>= 0` et non `> 0` : plusieurs clés de cette classe utilisent 0 comme "désactivé"
// documenté (`*_debit_cap_mad` = pas de débit, `whatsapp_retry_max_attempts` = pas de
// retente, `min_price` = pas de plancher global) et rien dans le code ne permet de distinguer
// un 0 voulu d'un 0 accidentel pour les autres.
//
// Périmètre = les 77 clés réellement déstructurées par PUT /admin/settings. `urgency_fee` et
// `accept_delay` sont seedées mais ABSENTES de l'allowlist (non modifiables via l'API) donc
// pas validées ici — si elles y entrent un jour, leur ajouter une règle (urgency_fee serait
// un { min: 0, max: 1 }, accept_delay n'a aucun lecteur).

// type: 'number' (défaut) | 'bool'
//   'bool'    → la valeur (après String()) doit être exactement 'true' ou 'false'. Choix
//               assumé : cohérent avec le code consommateur qui teste `=== 'true'`
//               (reliabilityScore.js:29, missions.js:1496/2426). Un booléen JS true/false d'un
//               client JSON se sérialise en 'true'/'false' et reste correct en aval → accepté.
//               '1', 1, 'on', 'TRUE'… sont REFUSÉS : le code les traiterait silencieusement
//               comme "off" — exactement la corruption silencieuse que ce chantier ferme.
//   integer   → true : la valeur doit être un entier (utilisée dans un `LIMIT $n` SQL).
//   min / max → bornes INCLUSIVES sur Number(valeur). Absente = pas de borne de ce côté.
const SETTING_RULES = {
  // ── Taux stockés comme fraction, utilisés en `prix * taux` — > 1 rend oeil_earning négatif,
  //    < 0 rend la commission/le remboursement négatif. FE Parametres = PERCENT_FIELDS (÷100).
  commission:          { min: 0, max: 1 },   // missions.js:34  Math.round(price*rate*100)/100 ; oeil_earning = price - commission
  refund_partial_rate: { min: 0, max: 1 },   // utils/refund.js:26  Math.round(mission.price*partialRate*100)/100

  // ── Pourcentage stocké tel quel (pas ÷100 côté FE), utilisé `earning * (percent/100)`.
  five_star_bonus_percent: { min: 0, max: 100 }, // missions.js:2428 ; `if (bonus > 0)` — >100 = bonus > gain intégral

  // ── Scores sur l'échelle de fiabilité 0-100 (computeReliabilityScore cl.js clamp 0..100).
  reactivation_default_score:         { min: 0, max: 100 }, // reliabilityRoutes.js:170/245 → reactivateWithCorrectiveEvent(newScore)
  dashboard_low_reliability_threshold:{ min: 0, max: 100 }, // users.js:578  reliability_score < $1::numeric

  // ── Drapeaux d'activation stricts (=== 'true' en aval).
  five_star_bonus_active:            { type: 'bool' }, // missions.js:1496, :2426
  late_cancel_penalty_tier1_enabled: { type: 'bool' }, // utils/reliabilityScore.js:29

  // ── Points de pénalité : TOUJOURS négatifs dans le code et les défauts (ajoutés au score,
  //    un "malus"). On borne le signe (<= 0), pas la magnitude (pas de réponse dans le code
  //    sur un plancher ; -70 est une valeur courante réelle).
  no_show_h30_penalty_points:                    { max: 0 }, // index.js:785 → logReliabilityEvent
  transfer_during_no_replacement_penalty_points: { max: 0 }, // missions.js:3589
  transfer_before_no_replacement_penalty_points: { max: 0 }, // missions.js:3625
  late_cancel_penalty_tier1_points:              { max: 0 }, // utils/reliabilityScore.js:19
  late_cancel_penalty_tier2_points:              { max: 0 }, // utils/reliabilityScore.js:20
  late_cancel_penalty_tier3_points:              { max: 0 }, // utils/reliabilityScore.js:21

  // ── Points de bonus : positifs (ajoutés au score, un "plus").
  transfer_before_replacement_bonus_points: { min: 0 }, // missions.js:2712

  // ── Tailles de lot injectées dans `LIMIT $n` → entier positif obligatoire (un `LIMIT 10.5`
  //    est absurde ; "nombre d'Œils à solliciter").
  candidate_batch_size:              { min: 1, integer: true }, // missions.js:4077  LIMIT $2
  urgent_mission_whatsapp_batch_size:{ min: 1, integer: true }, // missions.js:432   LIMIT $3

  // ── Classe générique : durées / compteurs / plafonds MAD / seuils / fenêtres de détection.
  //    Toutes : soit `INTERVAL '1 unité' * $n::numeric` (un négatif inverse la fenêtre / casse
  //    le cast), soit un compteur/seuil/plafond (un négatif n'a aucun sens). `>= 0`, aucune
  //    borne haute. Décimales tolérées (SQL INTERVAL et comparaisons acceptent 4.5).
  min_price:                                   { min: 0 }, // missions.js:320  +price < minPrice
  transfer_grace_minutes_queue:                { min: 0 }, // missions.js:115 etc. deadline = ... + grace
  transfer_grace_minutes_other:                { min: 0 }, // idem
  candidate_window_minutes_fast:               { min: 0 }, // DEAD (aucun getSetting) — validé au type d'après le nom
  candidate_window_minutes_choose_queue:       { min: 0 }, // DEAD
  candidate_window_minutes_choose_other:       { min: 0 }, // DEAD
  mission_edit_approval_minutes:               { min: 0 }, // missions.js:1163  Date.now() + delayMinutes*60000
  mission_edit_approval_minutes_urgent:        { min: 0 }, // missions.js:1162
  mission_edit_urgent_threshold_hours:         { min: 0 }, // missions.js:1161  hoursUntilMission < threshold
  client_validation_hours:                     { min: 0 }, // autoValidateMissions.js:23  INTERVAL '1 hour' * $1 ; + garde croisée C3 dans la route
  client_validation_reminder_hours:            { min: 0 }, // autoValidateMissions.js:146 ; + garde croisée C3 dans la route
  schedule_conflict_window_hours:              { min: 0 }, // oeilAssignment.js:50, missions.js:2501
  transfer_cooldown_hours:                     { min: 0 }, // missions.js:2694  NOW() + INTERVAL '1 hour' * $2
  transfer_cooldown_before_hours:              { min: 0 }, // index.js:845, missions.js:2701
  abandon_during_mission_cooldown_hours:       { min: 0 }, // missions.js:3611
  stale_mission_hours:                         { min: 0 }, // index.js:1518  INTERVAL '1 hour' * $1
  stale_mission_min_lead_hours:                { min: 0 }, // index.js:1519  INTERVAL '1 hour' * $2
  mission_overdue_verification_hours:          { min: 0 }, // index.js:925
  late_start_alert_window_minutes:             { min: 0 }, // index.js:726/779  INTERVAL '1 minute' * $n
  late_start_auto_transfer_minutes:            { min: 0 }, // index.js:779
  reminder_before_mission_minutes_early:       { min: 0 }, // index.js:992/1146  NOW() + INTERVAL '1 minute' * $n
  reminder_before_mission_minutes_late:        { min: 0 }, // index.js:992
  refund_partial_threshold_hours:              { min: 0 }, // utils/refund.js:24  hoursBeforeMission > threshold
  new_oeil_mission_threshold:                  { min: 0 }, // reliabilityScore.js isNewOeil ; missions.js:1662 totalMissions < threshold
  ticket_auto_resolve_hours:                   { min: 0 }, // index.js:1587  INTERVAL '1 hour' * $1
  response_time_max_valid_minutes:             { min: 0 }, // utils/responseTime.js:23
  response_time_min_turns:                     { min: 0 }, // utils/responseTime.js:24  (comparaison, pas LIMIT → décimale tolérée)
  dashboard_stuck_pending_hours:               { min: 0 }, // users.js:576  INTERVAL '1 hour' * $1
  candidate_confirmation_minutes:              { min: 0 }, // missions.js:4083  Date.now() + minutes*60000 ; unreadWhatsappEmailFallback.js:34
  presence_confirmation_deadline_minutes:      { min: 0 }, // index.js:513
  presence_confirmation_deadline_minutes_sameday:{ min: 0 }, // index.js:1000
  presence_confirmation_deadline_minutes_h45:  { min: 0 }, // index.js:1061
  candidate_tiebreak_window_minutes:           { min: 0 }, // missions.js:4217  NOW() + INTERVAL '1 minute' * $2
  candidate_batch_max_waves:                   { min: 0 }, // missions.js:4066  batch_wave_count >= maxBatchWaves (0 = bascule élargie immédiate)
  activity_photo_interval_minutes:             { min: 0 }, // media.js:92, missions.js:3813
  urgent_mission_whatsapp_batch_delay_minutes: { min: 0 }, // missions.js:424
  candidature_whatsapp_seuil_count:            { min: 0 }, // missions.js:2539  COUNT(*) >= $n (comparaison → décimale tolérée)
  candidature_whatsapp_seuil_minutes:          { min: 0 }, // index.js:1417/1426  INTERVAL '1 minute' * $1
  candidature_relance_first_after_minutes:     { min: 0 }, // jobs/candidatureRelance.js:20/33
  candidature_relance_interval_minutes:        { min: 0 }, // jobs/candidatureRelance.js:21/35
  candidature_relance_imminent_threshold_minutes:{ min: 0 }, // jobs/candidatureRelance.js:22
  unread_whatsapp_email_fallback_minutes:      { min: 0 }, // jobs/unreadWhatsappEmailFallback.js:13/24
  whatsapp_retry_max_attempts:                 { min: 0 }, // jobs/whatsappRetry.js:49  retry_count < $1 (0 = plus de retente)
  payment_attempt_abandoned_minutes:           { min: 0 }, // payments.js:194/202
  no_show_h30_debit_cap_mad:                   { min: 0 }, // index.js:786  Math.min(cap, balance) (0 = pas de débit)
  transfer_during_no_replacement_debit_cap_mad:{ min: 0 }, // missions.js:3588  Math.min(cap, balance)
  late_cancel_penalty_tier1_threshold_hours:   { min: 0 }, // utils/reliabilityScore.js:22  préavis en heures
  late_cancel_penalty_tier2_threshold_hours:   { min: 0 }, // utils/reliabilityScore.js:23
  password_reset_token_expiry_hours:           { min: 0 }, // auth.js:241
  fraud_oeil_cancel_lookback_days:             { min: 0 }, // antiFraud.js:139  INTERVAL '1 day' * $2
  fraud_oeil_nomedia_lookback_days:            { min: 0 }, // antiFraud.js:153
  fraud_oeil_too_fast_lookback_days:           { min: 0 }, // antiFraud.js:166
  fraud_oeil_too_fast_seconds:                 { min: 0 }, // antiFraud.js:162  seuil "terminée en < N s"
  fraud_rating_spike_window_hours:             { min: 0 }, // antiFraud.js:182/188  INTERVAL '1 hour' * $2
  fraud_client_cancel_lookback_days:           { min: 0 }, // antiFraud.js:215
  fraud_client_refund_lookback_days:           { min: 0 }, // antiFraud.js:224
  fraud_client_fake_mission_lookback_days:     { min: 0 }, // antiFraud.js:237
  fraud_client_fake_mission_seconds:           { min: 0 }, // antiFraud.js:238  seuil "annulée en < N s"
  fraud_message_scan_lookback_days:            { min: 0 }, // antiFraud.js:265
  fraud_dashboard_recent_days:                 { min: 0 }, // antiFraud.js:293
  fraud_dashboard_cancellations_days:          { min: 0 }, // antiFraud.js:294
};

// Renvoie null si la valeur est acceptable pour cette clé, sinon un fragment de message
// d'erreur en français (sans le nom de la clé — l'appelant le préfixe). `key` inconnue de
// SETTING_RULES → null (on ne bloque pas une clé qu'on ne connaît pas : l'allowlist de la
// route reste l'autorité sur ce qui est écrit).
function validateSettingValue(key, rawValue) {
  const rule = SETTING_RULES[key];
  if (!rule) return null;

  const s = String(rawValue).trim();

  if (rule.type === 'bool') {
    if (s === 'true' || s === 'false') return null;
    return `doit valoir 'true' ou 'false' (reçu : ${JSON.stringify(String(rawValue))})`;
  }

  // Nombre. On accepte exactement ce que getSetting (utils/settings.js) saurait relire comme
  // un nombre fini : chaîne non vide qui se coerce en nombre fini. Rejette '', '  ', 'abc',
  // '10abc', 'Infinity', 'NaN', null, {} ([object Object]), [] ('')…
  if (s === '' || !Number.isFinite(Number(s))) {
    return `doit être un nombre (reçu : ${JSON.stringify(String(rawValue))})`;
  }
  const n = Number(s);
  if (rule.integer && !Number.isInteger(n)) {
    return `doit être un entier (reçu : ${n})`;
  }
  if (rule.min !== undefined && n < rule.min) {
    return `doit être supérieur ou égal à ${rule.min} (reçu : ${n})`;
  }
  if (rule.max !== undefined && n > rule.max) {
    return `doit être inférieur ou égal à ${rule.max} (reçu : ${n})`;
  }
  return null;
}

module.exports = { SETTING_RULES, validateSettingValue };
