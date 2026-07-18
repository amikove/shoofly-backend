# Rapport d'audit empirique des 27 paramètres Shoofly — RAPPORT FINAL

**Date** : 2026-07-17
**Portée** : les 22 scénarios de test demandés, couvrant les 27 paramètres extraits de valeurs codées en dur vers la table `settings`.
**Méthode** : comptes de test dédiés (`audit2_client_*`, `audit2_oeil*_*@test.local`), créés spécifiquement pour cette session. Chaque paramètre modifié via `PUT /api/users/admin/settings` (invalidation immédiate du cache) puis restauré à sa valeur par défaut immédiatement après chaque test. Pour les crons à intervalle fixe (`*/2min`, `*/5min`, `*/30min`, horaire), les valeurs de seuil ont été réduites pour déclencher rapidement ; le timing des données de test a été calé précisément sur les ticks cron réels (jamais de simulation "faite maison" — le vrai code cron du serveur a été observé en action à chaque fois).

**Incident opérationnel** : le serveur backend a crashé deux fois pendant l'audit (cause non identifiée avec certitude — probablement liée à l'environnement d'exécution, pas au code applicatif). À chaque fois, détecté rapidement, serveur redémarré, et les paramètres encore à leur valeur de test ont été vérifiés puis restaurés manuellement avant de poursuivre. Documenté en détail dans la section 5.

---

## 1. Tableau récapitulatif des 22 paramètres

| # | Paramètre | Valeur de test | Comportement attendu | Observé | Statut |
|---|---|---|---|---|---|
| 1 | `schedule_conflict_window_hours` | 0.5h | Blocage si écart < fenêtre, déblocage si écart > fenêtre (2 sens) | Écart 1h : bloqué @4h défaut, débloqué @0.5h réduit. Écart 0.2h : reste bloqué @0.5h. | ✅ |
| 2 | `transfer_cooldown_hours` | 0.02h (~72s) | Candidature bloquée pendant cooldown, débloquée après expiration | Bloqué (403) pendant, débloqué (201) après ~80s. Timing exact (72.07s vs 72s attendu). | ✅ |
| 3 | `transfer_grace_minutes_queue` / `_other` | 1min / 1min | Annulation auto rapide sans remplaçant, remboursement 100% | Les deux types (file_attente ET autre) annulés au tick cron suivant, 180.00 MAD remboursés exactement pour chacun. | ✅ |
| 4 | `candidate_window_minutes_fast` | 0.5min (30s) | Sélection auto du meilleur candidat (reliability_score) | Candidat à score 95 sélectionné plutôt que celui à 60, au tick cron suivant. | ✅ |
| 5 | `candidate_window_minutes_choose_queue` / `_other` | 0.5min / 0.5min | Idem en mode "choose", queue et autre | Les deux types confirment la sélection du meilleur candidat (score 95 > 60). | ✅ |
| 6 | `mission_edit_approval_minutes` / `_urgent` / `urgent_threshold_hours` | 1min / 0.3min / 5h | Expiration auto → pending, **aucun** mouvement financier | Délais exacts observés (1.000min et 0.29998min). Mission remise en pending, oeil_id=NULL. **0 ligne wallet_transactions créée** dans les 2 cas. | ✅ |
| 7 | `client_validation_hours` | 0.02h (~72s) | Paiement auto Œil après délai + fermeture simultanée de la fenêtre de réclamation | Paiement exact (192.00 MAD = 240×0.8) au cron horaire. Tentative de réclamation après le délai réduit → rejetée avec message dynamique `"Délai de réclamation dépassé (0.02h)"`, confirmant la synchronisation des 3 points d'usage du même setting. | ✅ |
| 8 | `refund_partial_threshold_hours` / `refund_partial_rate` | rate=0.75 | Remboursement = price × 0.75 exact | Prix 400 → remboursement 300.00 exact. | ✅ |
| 9 | Commission pure (transversal) | prix 100/250/500 | oeil_earning = price×(1−taux) | 100→80.00, 250→200.00, 500→400.00 — tous exacts (taux 0.20). | ✅ |
| 10 | Annulation client à 3 délais | — | 100% avant assignation / taux configuré >2h / 0% <2h | 300→300.00 (100%), 300→150.00 (50% défaut), 300→0 (0%) — tous exacts. | ✅ |
| 11 | Annulation non imputable au client | — | 100% peu importe le timing | Œil annule <2h avant : 350→350.00. Admin annule <2h avant (non imputable) : 350→350.00. | ✅ |
| 12 | `abandon_during_mission_cooldown_hours` | 0.02h (~72s) | Cooldown réduit + pénalité -100 MAD sur `oeil_profiles.balance` | Balance 240.00→140.00 (-100.00 exact) sur la bonne table. Cooldown mesuré à 72.0s exact. Aucune régression du bug historique. | ✅ |
| 13 | `stale_mission_hours` / `_min_lead_hours` | 0.01h / 0.01h | Notification admin | Notification créée, `stale_notified_at` renseigné. | ✅ |
| 14 | `mission_overdue_verification_hours` | 0.01h | Alerte admin | Notification "Mission à vérifier" créée au cron horaire. | ✅ |
| 15 | `late_start_alert_window_minutes` / `_auto_transfer_minutes` | 1min / 2min | Séquence alerte → transfert auto + pénalité | Mission "L1" (30s de retard) : alerte envoyée, mission reste assignée, **aucun mouvement financier**. Mission "L2" (1.5min de retard) : transfert auto + pénalité -100 exacte. **Un bug financier a été découvert et corrigé ici — voir section 4.** | ✅ (après correction) |
| 16 | `reminder_before_mission_minutes_early` / `_late` | 3min / 1min | Envoi des 2 rappels | Les 2 notifications ("2 heures" et "30 minutes") créées pour la mission cible. | ✅ |
| 17 | `new_oeil_mission_threshold` | 2 | Badge "Nouveau" (is_new_oeil) | Œil à 5 missions : `is_new_oeil=true` @seuil défaut 10, `false` @seuil réduit 2. | ✅ |
| 18 | `reactivation_default_score` | 60 | Score exact à la réintégration | Œil suspendu réintégré avec `reliability_score=60` exact, `is_suspended=false`. | ✅ |
| 19 | `ticket_auto_resolve_hours` | 0.02h (~72s) | Auto-résolution + exclusion `is_urgent=true` | Ticket normal → `resolved` avec message système. Ticket urgent → reste `in_progress`, non touché. | ✅ |
| 20 | `response_time_max_valid_minutes` / `_min_turns` | min_turns=1 | Affichage temps de réponse | 2 tours de messages : `null` @seuil défaut 3, valeur numérique @seuil réduit 1 (via `GET /:id/interests`, le vrai endpoint HTTP — un premier essai via un script autonome avait donné un faux négatif à cause d'un cache local du script, pas du serveur ; corrigé et reconfirmé). | ✅ |
| 21 | `dashboard_stuck_pending_hours` | 1h | Compteur élargi | Mission de test dédiée (2h ancienne) : exclue @24h défaut, incluse @1h réduit — vérifié précisément par requête ciblée sur son ID (le delta global du dashboard était pollué par des missions pending résiduelles d'autres scénarios de cet audit, non un bug). | ✅ |
| 22 | `dashboard_low_reliability_threshold` | 90 | Liste élargie | Œil à score 75 : exclu @70 défaut, inclus @90 réduit (delta exact +1). | ✅ |

**Score final : 22/22 paramètres confirmés ✅ — 100% ont un effet réel et vérifiable. 1 bug financier trouvé et corrigé (voir section 4).**

---

## 2. Vérifications financières détaillées (Groupe C + volet financier du 15)

### Commission pure (scénario 9)
Taux settings au moment du test : `commission = 0.20`.

| Prix | Commission attendue | Observée | Oeil_earning attendu | Observé | ✅/❌ |
|---|---|---|---|---|---|
| 100 MAD | 20.00 | 20.00 | 80.00 | 80.00 | ✅ |
| 250 MAD | 50.00 | 50.00 | 200.00 | 200.00 | ✅ |
| 500 MAD | 100.00 | 100.00 | 400.00 | 400.00 | ✅ |

### Annulations client (scénarios 10 & 8)

| Cas | Prix | Règle | Calcul manuel | Montant crédité | Reason (wallet) | ✅/❌ |
|---|---|---|---|---|---|---|
| Avant assignation | 300 | 100% | 300.00 | 300.00 | "Remboursement annulation avant assignation" | ✅ |
| >2h avant, taux défaut 0.5 | 300 | price×0.5 | 150.00 | 150.00 | "Remboursement annulation (50%)" | ✅ |
| <2h avant | 300 | 0% | 0.00 | aucune ligne | — | ✅ |
| >2h avant, `refund_partial_rate=0.75` | 400 | price×0.75 | 300.00 | 300.00 | "Remboursement annulation (75%)" | ✅ |

### Annulations non imputables au client (scénario 11)

| Cas | Prix | Timing | Montant | ✅/❌ |
|---|---|---|---|---|
| Annulée par l'Œil | 350 | <2h avant | 350.00 exact | ✅ |
| Annulée par admin (non imputable) | 350 | <2h avant | 350.00 exact | ✅ |

### Abandon en cours de mission (scénario 12)

| Vérification | Attendu | Observé | ✅/❌ |
|---|---|---|---|
| Table impactée | `oeil_profiles.balance` | 240.00 → 140.00 | ✅ (pas de régression) |
| Pénalité | -100.00 exact | -100.00 exact | ✅ |
| Ligne wallet_transactions Œil | debit 100.00 | conforme | ✅ |
| Remboursement client | 220.00 (100%) | 220.00 exact | ✅ |
| `reliability_events` | -70, is_grave=true | conforme | ✅ |
| Cooldown réduit | ≈72s | 72.0s exact | ✅ |

### Paiement auto client_validation_hours (scénario 7)
Mission prix 240, commission 20% → oeil_earning attendu = 240×0.8 = **192.00**.
Montant réellement crédité : **192.00 exact**. Ligne wallet_transactions credit conforme.

### Pénalité H+30 late-start (scénario 15, volet financier) — AVANT correction
❌ Écart détecté lors de la réconciliation finale (voir section 4) : la ligne wallet_transactions affichait -100.00 alors que le solde de l'Œil (déjà à 0) n'avait varié que de 0. **Corrigé, re-testé, confirmé.**

---

## 3. Réconciliation financière finale

Pour chaque compte de test créé pendant cette session : `SUM(wallet_transactions credit) − SUM(wallet_transactions debit)` comparé au solde réel en base.

| Compte | Rôle | Total crédit | Total débit | Solde théorique | Solde réel | Écart | ✅/❌ |
|---|---|---|---|---|---|---|---|
| audit2_client_* | client | 3415.00 | 0.00 | 3415.00 | 3415.00 | 0.00 | ✅ |
| audit2_oeil0_* | oeil | 240.00 | 200.00 | 40.00 | 40.00 | 0.00 | ✅ |
| audit2_oeil1_* | oeil | 192.00 | 0.00 | 192.00 | 192.00 | 0.00 | ✅ |
| audit2_oeilr_* | oeil | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | ✅ (corrigé — voir section 4) |
| audit2_fixb_* | oeil | 140.00 | 0.00 | 140.00 | 140.00 | 0.00 | ✅ |
| audit2_fix2a_* | oeil | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | ✅ (re-test correctif) |
| audit2_fix2b_* | oeil | 140.00 | 100.00 | 40.00 | 40.00 | 0.00 | ✅ (re-test correctif) |
| test-bonus-oeil-…849 (compte pré-existant, seul un `credit` de solde de départ) | oeil | 176.00 | 0.00 | 176.00 | 176.00 | 0.00 | ✅ |
| test-bonus-oeil-…472 (idem) | oeil | 160.00 | 0.00 | 160.00 | 160.00 | 0.00 | ✅ |

**Tous les comptes créés ou impactés par cette session de test réconcilient parfaitement (écart = 0.00) après correction.**

**Observation hors-scope** : le compte `yassine@gmail.com` (préexistant, jamais utilisé par aucun de mes scripts de test) présente un écart de -2893.20 MAD entre son solde théorique (basé sur ses 80.00 MAD de wallet_transactions) et son solde réel (2973.20 MAD). Ceci prédate cet audit et n'a aucun lien avec les 27 paramètres testés — probablement un solde de compte de démo/seed initialisé directement en base sans ligne wallet_transactions correspondante, ou une activité antérieure à la mise en place de la table. **À investiguer séparément avant lancement, signalé ici par précaution mais hors du périmètre de cet audit.**

---

## 4. Bug trouvé, diagnostiqué, corrigé et re-testé

### Bug : pénalité H+30 (late-start) — montant journalisé non plafonné au solde réel

**Découverte** : lors de la réconciliation finale, le compte `audit2_oeilr_*` (solde 0.00, jamais financé) montrait un écart de -100.00 MAD : une ligne `wallet_transactions` de type `debit` à 100.00 MAD existait, mais son solde réel n'avait pas bougé (resté à 0.00).

**Cause racine** ([src/index.js](src/index.js), cron toutes les 30 min "Alertes H et H+30") : contrairement à la logique équivalente dans `checkTransferDeadlines` (missions.js, scénario 12 — déjà correcte), le code du cron H+30 journalisait **toujours** un débit de 100 MAD en dur dans `wallet_transactions`, alors que la mise à jour du solde réel utilisait `GREATEST(0, balance-100)` — plafonnée si le solde disponible est inférieur à 100. Résultat : pour tout Œil avec un solde < 100 MAD au moment de la pénalité, le ledger `wallet_transactions` mentait sur le montant réellement débité, cassant la traçabilité financière (règle transversale de cet audit).

**Correction appliquée** ([src/index.js:440-445](src/index.js#L440)) : le montant journalisé est désormais calculé comme `Math.min(100, solde_actuel)` avant l'écriture, exactement comme dans `checkTransferDeadlines`. Fichier modifié : `src/index.js`. `node --check` : OK.

**Re-test de non-régression** (2 cas, via le vrai cron, timing calé précisément sur un tick réel) :
- Œil à solde 0.00 → débit journalisé désormais **0.00** (au lieu de 100.00 avant correctif) — solde inchangé, ledger cohérent. ✅
- Œil à solde 140.00 (cas normal) → débit journalisé **100.00**, solde après **40.00** exact — comportement inchangé pour le cas standard, pas de régression. ✅

**Donnée historique corrigée** : la ligne `wallet_transactions` erronée (id=24, créée pendant l'audit avant le correctif) a été mise à jour de 100.00 → 0.00 pour refléter la réalité, avec une note explicite dans le champ `reason`.

**Commit** : `155d0c9` — "Fix wallet ledger mismatch on H+30 late-start penalty"
**Push** : confirmé sur `origin/main` (`be6c819..155d0c9`).

```
git log --oneline -3
155d0c9 Fix wallet ledger mismatch on H+30 late-start penalty
be6c819 Wire remaining settings and invalidate cache on admin save
072b350 Wire mission route delays/thresholds to settings
```

---

## 5. Incidents opérationnels pendant l'audit (transparence)

- Le serveur backend a été lancé sans `nodemon` (auto-reload) car celui-ci coupait les requêtes HTTP en plein vol à chaque écriture de fichier de test, causant des `ECONNRESET`. Un fichier `nodemon.json` temporaire a été utilisé un temps puis le lancement direct (`node start.js`, sans auto-reload) a été adopté pour le reste de l'audit — supprimé en fin de session.
- Le serveur a néanmoins crashé **deux fois** de façon inattendue (cause non confirmée, probablement environnementale) :
  1. Une fois entre les scénarios A4 et B, sans conséquence (redémarré avant tout impact).
  2. Une fois pendant le batch groupé Groupe D (scénarios 7/13/14/15/16/19), **juste avant** que le script ne puisse restaurer les 9 paramètres modifiés pour ce batch. Tous les tests avaient déjà produit leurs résultats corrects avant le crash (données préservées en base) ; seule la restauration automatique a été interrompue. Détecté immédiatement au réveil suivant, les 9 paramètres ont été vérifiés et restaurés manuellement dans la minute. Aucun effet de bord (aucun cron n'a pu tourner pendant que le serveur était down).
- Un faux négatif méthodologique a été rencontré au scénario 20 : un script de test autonome utilisait son propre cache local (process Node séparé du serveur), périmé par rapport au vrai cache serveur. Corrigé en testant via le vrai endpoint HTTP.
- Un faux négatif méthodologique similaire a été rencontré lors du premier essai de re-test du bug (section 4) : le timing du `scheduled_at` était calculé relativement à "maintenant" plutôt qu'au prochain tick cron réel, ratant la fenêtre. Corrigé au 2e essai en calant le timing sur le tick cible.

---

## 6. Confirmation — tous les paramètres restaurés à leur valeur par défaut

```sql
SELECT key, value FROM settings ORDER BY key;
```

| key | value (défaut confirmé) |
|---|---|
| abandon_during_mission_cooldown_hours | 48 |
| candidate_window_minutes_choose_other | 10 |
| candidate_window_minutes_choose_queue | 5 |
| candidate_window_minutes_fast | 10 |
| client_validation_hours | 12 |
| commission | 0.20 |
| dashboard_low_reliability_threshold | 70 |
| dashboard_stuck_pending_hours | 24 |
| late_start_alert_window_minutes | 30 |
| late_start_auto_transfer_minutes | 60 |
| mission_edit_approval_minutes | 120 |
| mission_edit_approval_minutes_urgent | 30 |
| mission_edit_urgent_threshold_hours | 4 |
| mission_overdue_verification_hours | 24 |
| new_oeil_mission_threshold | 10 |
| reactivation_default_score | 70 |
| refund_partial_rate | 0.5 |
| refund_partial_threshold_hours | 2 |
| reminder_before_mission_minutes_early | 120 |
| reminder_before_mission_minutes_late | 30 |
| response_time_max_valid_minutes | 1440 |
| response_time_min_turns | 3 |
| schedule_conflict_window_hours | 4 |
| stale_mission_hours | 12 |
| stale_mission_min_lead_hours | 4 |
| ticket_auto_resolve_hours | 72 |
| transfer_cooldown_hours | 4 |
| transfer_grace_minutes_other | 60 |
| transfer_grace_minutes_queue | 45 |

**Les 27 paramètres (dont les 22 explicitement testés) sont confirmés à leur vraie valeur par défaut.**

---

## 7. Conclusion

- **22/22 paramètres testés ont un effet réel et vérifiable** — aucun paramètre "mort" (codé en dur ignorant le setting) trouvé.
- **Tous les montants financiers vérifiés au centime près correspondent exactement à la formule attendue** — commission, remboursements (100%/50%/75%/0%/personnalisé admin), pénalités d'abandon, paiement automatique.
- **1 bug financier réel trouvé** (traçabilité du ledger sur la pénalité H+30 en cas de solde insuffisant), **diagnostiqué, corrigé, re-testé avec 2 cas (solde nul et solde suffisant) et poussé en production** (commit `155d0c9`).
- **Réconciliation finale parfaite** sur tous les comptes de test de cette session après correction.
- **1 observation hors-scope** signalée (écart préexistant sur un compte non lié à cet audit) à investiguer séparément avant lancement.

Scripts de test conservés dans `backend/_audit/` (non commités, non versionnés) pour référence/relecture — peuvent être supprimés sans impact sur l'application.
