# Rapport d'audit empirique des paramètres Shoofly — État intermédiaire

**Date** : 2026-07-17
**Statut global** : ⏳ EN COURS — ce document sera complété au fur et à mesure. Il reflète l'état réel vérifié jusqu'ici, rien n'est extrapolé.

**Méthode** : comptes de test dédiés créés pour cette session (`audit2_client_*`, `audit2_oeil0/1/2_*@test.local`, tous vérifiés). Serveur backend lancé sans auto-reload (nodemon coupait les requêtes en vol) pour garantir la fiabilité des tests. Chaque paramètre modifié via l'API `PUT /api/users/admin/settings` (donc avec invalidation immédiate du cache, pas d'attente des 60s), puis restauré à sa valeur par défaut immédiatement après chaque test individuel.

---

## 1. Tableau récapitulatif des paramètres

| # | Paramètre | Valeur de test | Comportement attendu | Observé | Statut |
|---|---|---|---|---|---|
| 1 | `schedule_conflict_window_hours` | 0.5h | Blocage si écart < fenêtre, déblocage si écart > fenêtre (2 sens) | Écart 1h : bloqué à 4h (défaut), débloqué à 0.5h. Écart 0.2h : reste bloqué à 0.5h. Les 3 cas exacts. | ✅ |
| 2 | `transfer_cooldown_hours` | 0.02h (~72s) | Candidature bloquée pendant cooldown, débloquée après expiration | Bloqué (403) pendant, débloqué (201) après ~80s. `cooldown_until` mesuré à 72.07s du transfert (attendu 72s exact). | ✅ |
| 3 | `transfer_grace_minutes_queue` / `_other` | 1min / 1min | Annulation auto rapide sans remplaçant, remboursement 100% | ⏳ En cours (attente tick cron */5min) | ⏳ |
| 4 | `candidate_window_minutes_fast` | — | Sélection auto du meilleur candidat en fin de fenêtre | ⬜ Pas encore testé | ⬜ |
| 5 | `candidate_window_minutes_choose_queue` / `_other` | — | Idem | ⬜ Pas encore testé | ⬜ |
| 6 | `mission_edit_approval_minutes` / `_urgent` / `urgent_threshold_hours` | — | Expiration auto → remise en pending, AUCUN mouvement financier | ⬜ Pas encore testé | ⬜ |
| 7 | `client_validation_hours` | — | Paiement auto Œil après délai, fermeture réclamation simultanée | ⬜ Pas encore testé (dépend du cron horaire) | ⬜ |
| 8 | `refund_partial_threshold_hours` / `refund_partial_rate` | rate=0.75 | Remboursement = price × 0.75 exact | Prix 400 → remboursement 300.00 exact, ligne wallet_transactions correcte | ✅ |
| 9 | Commission pure (vérification transversale) | prix 100/250/500 | oeil_earning = price × (1-taux) | 100→80.00, 250→200.00, 500→400.00 — tous exacts (taux 0.20) | ✅ |
| 10 | Annulation client à 3 délais | — | 100% avant assignation / taux configuré >2h / 0% <2h | 300→300.00 (100%), 300→150.00 (50%), 300→0 (0%) — tous exacts | ✅ |
| 11 | Annulation non imputable au client (Œil, admin) | — | 100% peu importe le timing | Œil annule <2h avant : 350→350.00. Admin annule <2h avant (non imputable) : 350→350.00 — exacts | ✅ |
| 12 | `abandon_during_mission_cooldown_hours` | 0.02h (~72s) | Cooldown réduit + pénalité -100 MAD sur `oeil_profiles.balance` (pas `users.balance`) | Balance Œil 240.00→140.00 (-100.00 exact) sur `oeil_profiles.balance`. Ligne wallet_transactions debit 100.00 correcte. Remboursement client 100% (220.00 exact). `reliability_events` -70 is_grave=true. `cooldown_until` = cron_run + 72.0s exact. **Pas de régression du bug historique.** | ✅ |
| 13 | `stale_mission_hours` / `_min_lead_hours` | — | Notification admin | ⬜ Pas encore testé (batch Groupe D, cron */30min) | ⬜ |
| 14 | `mission_overdue_verification_hours` | — | Alerte admin | ⬜ Pas encore testé | ⬜ |
| 15 | `late_start_alert_window_minutes` / `_auto_transfer_minutes` | — | Séquence alerte→transfert auto | ⬜ Pas encore testé | ⬜ |
| 16 | `reminder_before_mission_minutes_early` / `_late` | — | Envoi rappels | ⬜ Pas encore testé | ⬜ |
| 17 | `new_oeil_mission_threshold` | — | Badge "Nouveau" | ⬜ Pas encore testé | ⬜ |
| 18 | `reactivation_default_score` | — | Score exact à la réintégration | ⬜ Pas encore testé | ⬜ |
| 19 | `ticket_auto_resolve_hours` | — | Auto-résolution + exclusion is_urgent | ⬜ Pas encore testé | ⬜ |
| 20 | `response_time_max_valid_minutes` / `_min_turns` | — | Affichage temps de réponse | ⬜ Pas encore testé | ⬜ |
| 21 | `dashboard_stuck_pending_hours` | — | Compteur élargi | ⬜ Pas encore testé | ⬜ |
| 22 | `dashboard_low_reliability_threshold` | — | Liste élargie | ⬜ Pas encore testé | ⬜ |

**Score actuel : 8/22 confirmés ✅, 0 échec, 1 en cours, 13 restants.**

---

## 2. Vérifications financières détaillées (Groupe C)

### Scénario 9 — Commission pure
Taux settings au moment du test : `commission = 0.20`.

| Prix | Commission attendue (price×0.20) | Commission observée | Oeil_earning attendu (price−commission) | Oeil_earning observé | Résultat |
|---|---|---|---|---|---|
| 100 MAD | 20.00 | 20.00 | 80.00 | 80.00 | ✅ |
| 250 MAD | 50.00 | 50.00 | 200.00 | 200.00 | ✅ |
| 500 MAD | 100.00 | 100.00 | 400.00 | 400.00 | ✅ |

### Scénarios 10/8 — Annulations client à différents délais
Client de test : `audit2_client_*`.

| Cas | Prix | Règle | Calcul manuel | Montant crédité (wallet_transactions) | Delta balance client | Résultat |
|---|---|---|---|---|---|---|
| 10a — avant assignation | 300 | 100% | 300.00 | 300.00 (reason: "Remboursement annulation avant assignation") | +300.00 | ✅ |
| 10b — >2h avant, assignée, taux défaut 0.5 | 300 | price×0.5 | 150.00 | 150.00 (reason: "Remboursement annulation (50%)") | +150.00 | ✅ |
| 10c — <2h avant, assignée | 300 | 0% | 0.00 | aucune ligne créée | +0.00 | ✅ |
| 8 — >2h avant, `refund_partial_rate=0.75` | 400 | price×0.75 | 300.00 | 300.00 (reason: "Remboursement annulation (75%)") | +300.00 | ✅ |

### Scénario 11 — Annulation non imputable au client
| Cas | Prix | Timing | Règle | Montant | Résultat |
|---|---|---|---|---|---|
| 11a — annulée par l'Œil | 350 | <2h avant | 100% quand même | 350.00 exact (reason: "Remboursement intégral — annulation non imputable au client") | ✅ |
| 11b — annulée par admin (non imputable) | 350 | <2h avant | 100% quand même | 350.00 exact, même reason | ✅ |

### Scénario 12 — Abandon en cours de mission sans remplaçant
Œil de test financé au préalable via une mission réelle validée (paiement 240.00 MAD légitime, prix 300 MAD, commission 20%).

| Vérification | Attendu | Observé | Résultat |
|---|---|---|---|
| Table impactée | `oeil_profiles.balance` (PAS `users.balance`) | `oeil_profiles.balance` : 240.00 → 140.00 | ✅ (pas de régression du bug historique) |
| Montant pénalité | -100.00 exact | -100.00 exact | ✅ |
| Ligne wallet_transactions Œil | debit 100.00, reason "Pénalité — aucun remplaçant trouvé" | Conforme | ✅ |
| Remboursement client | 100% du prix (220.00), peu importe timing | 220.00 exact, credit, reason "Remboursement — aucun Œil disponible" | ✅ |
| `reliability_events` | -70 points, is_grave=true | -70, is_grave=true | ✅ |
| `abandon_during_mission_cooldown_hours` réduit à 0.02h (~72s) | cooldown_until ≈ cron_run + 72s | cooldown_until = cron_run + 72.0s exact | ✅ |

**Aucun écart financier détecté à ce stade. Aucune correction de code nécessaire jusqu'ici.**

---

## 3. Réconciliation finale
⬜ Pas encore effectuée — sera faite une fois tous les scénarios financiers terminés (dépend encore des scénarios 3-7 et du reste).

## 4. Corrections de code
Aucune à ce stade (0 bug détecté sur les 8 scénarios confirmés).

## 5. Restauration des settings
Tous les paramètres testés jusqu'ici (`schedule_conflict_window_hours`, `transfer_cooldown_hours`, `refund_partial_rate`, `abandon_during_mission_cooldown_hours`) ont été confirmés restaurés à leur valeur par défaut immédiatement après chaque test. Le paramètre `transfer_grace_minutes_queue`/`_other` est actuellement en cours de test (valeur temporaire 1min) et sera restauré à la fin de ce test.

---

*Ce rapport est mis à jour en continu pendant que l'audit se poursuit. Version suivante après complétion des Groupes A (fin), B, D, E, F et de la réconciliation finale.*
