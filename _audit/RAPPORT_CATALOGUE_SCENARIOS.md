# Rapport d'audit empirique — Catalogue de scénarios (PHASE FINALE avant lancement)

**Date** : 2026-07-18
**Portée** : les 10 catégories / ~40 scénarios demandés (cycle de vie, annulations, remplacement, modification, fiabilité, notifications/WhatsApp, tickets, anti-fraude, promo, concurrence).
**Méthode** : comptes de test dédiés créés spécifiquement pour cette session (`s_client_*`, `s_oeil*_*@test.local`, plusieurs lots successifs `oeils2` à `oeils5` pour garantir des comptes sans historique contaminant), sur backend local (`node start.js`, port 3001) + PostgreSQL local (copie de travail, même code que la production — voir méthodologie détaillée en mémoire projet). Chaque paramètre modifié pour accélérer un cron a été restauré à sa valeur par défaut immédiatement après usage. Aucune donnée réelle de production n'a été touchée.

**⚠️ Vérification préalable (priorité absolue demandée)** : le refactoring de centralisation (state machine `missionStateMachine.js` + primitives wallet `walletService.js` + transactions atomiques) est confirmé **complet et cohérent** — vérifié par lecture directe du code et par le comportement observé sur tous les scénarios ci-dessous (transitions atomiques avec garde optimiste, credit/debit toujours couplés à une ligne `wallet_transactions`). Seule anomalie relevée : suppression non commitée de `src/routes/reliability.js` et `src/utils/reliability.js` (renommés en `reliabilityRoutes.js`/`reliabilityScore.js` de longue date, plus aucune référence aux anciens chemins) — hygiène git à faire, sans aucun impact fonctionnel.

---

## Légende
✅ conforme · ❌ bug trouvé (corrigé) · ⚠️ écart mineur sans impact financier/fonctionnel · 🔲 non couvert (gap produit, pas un bug de code existant)

---

## Catégorie 1 — Cycle de vie normal

| # | Scénario | Résultat technique | Résultat financier | Statut |
|---|---|---|---|---|
| 1.1 | Commande→postule→embauche→termine→validation client immédiate | mission `pending→assigned→completed`, `validated_at` renseigné | prix 300, commission 20%→60.00, oeil_earning attendu 240.00 = observé 240.00 exact, wallet_transactions credit "Validation client" | ✅ |
| 1.2 | Idem, client NE valide PAS → auto-validation cron horaire (`0 * * * *`, réel, attendu au vrai tick 20h00) | mission `validated_at` renseigné automatiquement, sans action client | oeil_earning 208.00 (prix 260×0.8) crédité exact, reason="Validation automatique après délai" — **identique au cas manuel** (seule la reason diffère, intentionnel) | ✅ |
| 1.3 | Réclamation tentée APRÈS validation | HTTP 400 "Cette mission a déjà été validée, aucune réclamation n'est plus possible." | — | ✅ |

---

## Catégorie 2 — Annulations, toutes combinaisons

| # | Scénario | Calcul attendu | Observé | Statut |
|---|---|---|---|---|
| 2.1 | Client annule AVANT assignation | 100% = 300.00 | 300.00, reason="Remboursement annulation avant assignation" | ✅ |
| 2.2 | Client annule, assignée, >2h avant | price×0.5 = 150.00 | 150.00, reason="Remboursement annulation (50%)" | ✅ |
| 2.3 | Client annule, assignée, <2h avant | 0.00, aucune ligne | 0.00, aucune ligne wallet_transactions | ✅ |
| 2.4 | Admin annule SANS client_at_fault, <2h avant | 100% malgré timing = 350.00 | 350.00, reason="Remboursement intégral — annulation non imputable au client" | ✅ |
| 2.5a | Admin annule AVEC client_at_fault=true, >2h avant | même grille que 2.2 = 150.00 | 150.00 | ✅ |
| 2.5b | Admin annule AVEC client_at_fault=true, <2h avant | même grille que 2.3 = 0.00 | 0.00 | ✅ |
| 2.6 | Transfert 'during', remplaçant trouvé, chaîne à 3 Œils | split prorata sur durées réelles (3037/6411/3765ms) : 110.33/232.90/136.77 (Σ=480.00=oeil_earning) | exact sur les 3 maillons, delta balance = part exacte pour chacun | ✅ |
| 2.7 | Transfert 'during', AUCUN remplaçant | -70 fiabilité (grave), pénalité min(100,solde)=0.00 (solde nul), remboursement client 100%=320.00, cooldown 48h | exact sur tous les points — **non-régression confirmée du fix `155d0c9`** (session 2026-07-17) | ✅ |
| 2.8 | Transfert 'before', remplaçant trouvé | +5 fiabilité, paiement intégral au 2e Œil, **aucune ligne mission_transfer_chain** | +5 fiabilité exact, paiement intégral exact (224.00), **MAIS 1 ligne mission_transfer_chain créée** | ⚠️ |
| 2.9 | Transfert 'before', AUCUN remplaçant | -10 fiabilité SEULEMENT (différent de 2.7), 0 pénalité financière, remboursement 100%=280.00 | exact — comportement bien différent de 2.7 confirmé | ✅ (bug de réassignation fantôme trouvé et corrigé au passage, voir section Bugs) |

**⚠️ 2.8 — précision** : la ligne `mission_transfer_chain` créée n'est **pas spécifique** au cas 'before' — c'est le bootstrap universel qui s'ouvre pour TOUTE mission atteignant le statut 'active' (vérifié : la mission du scénario 1.1, jamais transférée, présente exactement la même ligne orpheline `ended_at=NULL`). Elle n'a **aucun impact financier** : la logique de split en validation ne lit ces lignes que si `mission.transfer_type='during'`, jamais pour 'before'. Reclassé en observation de hygiène de données (ligne orpheline inerte), pas en bug financier — non corrigé pour ne pas risquer de régresser le mécanisme de split (catégorie 2.6, prouvé correct) pour un gain purement cosmétique.

---

## Catégorie 3 — Préférence de remplacement

| # | Scénario | Attendu | Observé | Statut |
|---|---|---|---|---|
| 3.1 | Mode 'fast', 2 candidats (score 95 vs 60) | meilleur score sélectionné après fenêtre | oeil_id = candidat score 95 (pas le score 60, ni l'Œil d'origine transféré) | ✅ |
| 3.2 | Mode 'choose', client choisit AVANT expiration | choix respecté, fenêtre fermée immédiatement | oeil_id = choix client, `candidate_window_ends_at=NULL` immédiatement après `/hire`, confirmé stable après le tick cron suivant | ✅ |
| 3.3 | Mode 'choose', personne ne répond | sélection auto du seul candidat réel après délai adaptatif | oeil_id = seul candidat réel (pas l'Œil d'origine malgré sa candidature fantôme pré-correctif) | ✅ |
| 3.4 | POST /accept pendant fenêtre active | bloqué, message clair | HTTP 400 "Cette mission est en phase de sélection de remplaçant..." | ✅ |

---

## Catégorie 4 — Modification de mission

| # | Scénario | Attendu | Observé | Statut |
|---|---|---|---|---|
| 4.1 | Mission pending, client modifie | application immédiate | HTTP 200, `applied:true`, titre mis à jour immédiatement | ✅ |
| 4.2 | Mission assigned, Œil APPROUVE | changements appliqués, **aucune pénalité, aucun mouvement financier** | titre appliqué, status reste assigned, reliability_events et wallet_transactions counts strictement inchangés | ✅ |
| 4.3 | Mission assigned, Œil REFUSE | repasse pending/oeil_id=NULL même id, aucune pénalité | confirmé, même id, titre proposé NON appliqué, reliability_events inchangé | ✅ |
| 4.4 | Idem, expiration automatique (pas de réponse) | même résultat que 4.3 | mission pending/oeil_id=NULL même id, titre original inchangé, `edit_request.status='expired'` | ✅ |
| 4.5 | Modifier price/type/subcategory | rejeté 400 | HTTP 400 "Champs non modifiables après création" pour les 3 champs | ✅ |
| 4.6 | 2e demande pendant une en attente | rejeté 409 | HTTP 202 (1ère) puis HTTP 409 "Une demande de modification est déjà en attente..." | ✅ |

---

## Catégorie 5 — Fiabilité et suspension

| # | Scénario | Attendu | Observé | Statut |
|---|---|---|---|---|
| 5.1 | Refus à 3 délais (>24h / 2-24h / <2h) | -15 / -35 / -50 exacts | -15 (grave=false), -35 (grave=true), -50 (grave=true) — exacts | ✅ |
| 5.2 | Score sous 50% → suspension | liste vide (`mode=available`), pas 403 | 10 événements → score=0, `is_suspended=true`, `GET ?mode=available` → HTTP 200, `missions:[]` | ✅ |
| 5.3a | Réintégration admin, score cible | score exact obtenu | **Bug trouvé** : cible 65 → 70 obtenu (perte de précision). **Corrigé** → cible 65 → 65 exact (+ 63, 92, 100 testés exacts) | ❌→✅ |
| 5.3b | Note 5/5 après réintégration | ne rechute PAS sous 50% | score 65→83 après note 5/5, `is_suspended=false` — bug historique de rechute illusoire confirmé absent | ✅ |
| 5.4 | Œil <10 missions | badge "Nouveau" au client (score masqué), score réel à lui-même/admin | client: `is_new_oeil=true`, `reliability_score=null` · self/admin : score réel exposé | ✅ |
| 5.5 | Bonus qualité 5★ actif | montant exact + dépense Marketing | bonus = oeil_earning(400)×10% = 40.00 exact, wallet credit 40.00, dépense Marketing 40.00 créée | ✅ |

**Note méthodologique 5.2** : `/refuse` pose lui-même un cooldown de 4h (`transfer_cooldown_hours`), rendant impossible d'enchaîner 10 refus via l'API en peu de temps (constaté, pas un bug — anti-abus cohérent). Le montant de pénalité étant déjà prouvé exact en 5.1, le seuil de suspension a été isolé en invoquant directement la fonction serveur réelle (`logReliabilityEvent`), sans réimplémentation.

---

## Catégorie 8 — Anti-fraude et sécurité

| # | Scénario | Attendu | Observé | Statut |
|---|---|---|---|---|
| 8.1a | Ville invalide (API directe) | HTTP 400 | "Ville invalide" | ✅ |
| 8.1b | Sous-catégorie invalide (API directe) | HTTP 400 | "Sous-catégorie invalide pour ce type de mission" | ✅ |
| 8.2a | Doublon email inscription | HTTP 409 | "Email déjà utilisé" | ✅ |
| 8.2b | Doublon téléphone inscription | HTTP 409 | "Numéro de téléphone déjà utilisé" | ✅ |
| 8.2c | Doublon téléphone modification profil | HTTP 409 | "Numéro de téléphone déjà utilisé" | ✅ |
| 8.3 | Admin non-superAdmin désactive un autre admin | HTTP 403 | "Seul le Super Admin peut activer/désactiver un compte administrateur." | ✅ |

Note : l'email n'est modifiable par **aucune** route (`PUT /auth/me` ne l'accepte pas) — le doublon email n'est donc vérifiable qu'à l'inscription, pas en modification (pas un gap, juste une absence de fonctionnalité de changement d'email).

---

## Catégorie 9 — Codes promo

| # | Scénario | Calcul attendu | Observé | Statut |
|---|---|---|---|---|
| 9.1 | Code pourcentage (15%) | discount = 400×0.15 = 60.00 | 60.00, final_price=340.00 | ✅ |
| 9.2 | Code gratuit (type='free') | dépense Promotions = platform_amount exact (250.00) | oeil_earning=250.00, commission=0.00, 1 dépense Promotions de 250.00 | ✅ |
| 9.2-bis | Code réel déjà utilisé (max_uses_per_user=1) + tentative de falsifier platform_amount | rejeté 400 | HTTP 400 "Vous avez déjà utilisé ce code" | ✅ (voir bug fraude ci-dessous) |
| 9.3a | Code expiré | HTTP 400 | "Code promo expiré" | ✅ |
| 9.3b | Code dupliqué (casse différente) | HTTP 201 puis 409 | "Le code ... existe déjà" | ✅ |

---

## Catégorie 10 — Cas limites et concurrence

| # | Scénario | Attendu | Observé | Statut |
|---|---|---|---|---|
| 10.1 | Double-clic (2×`/validate` strictement concurrents, `Promise.all`) | 1 seule action effective | 1×HTTP200 + 1×HTTP400, **1 seule** ligne wallet_transactions, delta balance = oeil_earning exact (pas le double) | ✅ |
| 10.2 | 2 admins simultanés (annule vs assigne) | pas d'état incohérent | 1×HTTP200 (cancel) + 1×HTTP409 (assign, `STALE_STATE`), état final cohérent : `cancelled`/`oeil_id=NULL` | ✅ |
| 10.3 | Œil désactivé (`is_active=false`) avec mission **active** en cours | réaffectation automatique, aucune pénalité | **Aucun mécanisme n'existe** : mission reste bloquée indéfiniment, Œil bloqué par l'auth (401), personne n'est notifié. Voir section Gaps. | 🔲 |

---

## Catégorie 6 — Notifications et WhatsApp

**Inventaire réel des points de déclenchement** (recherche exhaustive `sendWhatsAppTemplate` dans le code, 2026-07-18) — les 8 ont été déclenchés empiriquement via le vrai flux applicatif (numéro réel `+212661064492` fourni par l'utilisateur) :

| Événement métier | Fichier | Template Wasel réel | Destinataire | Déclenché correctement | Wasel HTTP |
|---|---|---|---|---|---|
| Client propose une modification | missions.js | `ticket_urgent_ouvert` | Œil | ✅ (HTTP 202) | ❌ 502 |
| Œil approuve la modification | missions.js | `ticket_urgent_ouvert` | Client | ✅ (HTTP 200) | ❌ 502 |
| Œil refuse la modification | missions.js | `ticket_urgent_ouvert` | Client | ✅ (HTTP 200) | ❌ 502 |
| Modification expire sans réponse (cron) | missions.js | `ticket_urgent_ouvert` | Client | ✅ (edit_request expiré, mission repending) | ❌ 502 |
| Mission marquée terminée | missions.js | `ticket_urgent_ouvert` | Client | ✅ (HTTP 200) | ❌ 502 |
| Œil postule (candidature) | missions.js | `ticket_urgent_ouvert` | Client | ✅ (HTTP 201) | ❌ 502 |
| Œil embauché | missions.js | `nouvelle_verification_identite` | Œil | ✅ (HTTP 200) | ❌ 502 |
| Identité approuvée par admin | users.js | `nouvelle_verification_identite` | Œil | ✅ (HTTP 200) | ❌ 502 |

**🚨 Constat critique (6.1)** : le déclenchement applicatif est **irréprochable** — chacun des 8 événements appelle bien `sendWhatsAppTemplate` au bon moment, avec le bon destinataire et les bonnes variables. Mais **les 8 envois réels échouent**, avec le vrai numéro WhatsApp de l'utilisateur, HTTP 502 de Wasel à chaque fois :
- `(#100) Invalid parameter` pour les appels `ticket_urgent_ouvert`
- `(#131009) Parameter value is not valid` pour `nouvelle_verification_identite` (numéros de test factices — attendu, pas un problème)

**Diagnostic** : un appel direct à l'API Wasel (`https://wasel-api.wasel.ma/external/v1/send-template`), **totalement en dehors de l'application**, avec un payload minimal et le vrai numéro `+212661064492`, reproduit l'échec identique sur les DEUX templates. Ce n'est donc **pas un bug de code Shoofly** — la construction de la requête est correcte. C'est un problème externe côté compte Wasel/Meta Business (candidats les plus probables : templates non approuvés en production côté Meta Business Manager, numéro de test non enregistré sur un compte WhatsApp Business encore en mode développement, ou restriction sur la clé API/le compte). **Constaté sur l'intégralité des ~80 minutes de cette session** (dès les tout premiers tests de catégorie 1) — pas un incident ponctuel.

**⚠️ Recommandation urgente avant lancement** : à ce jour, **aucune notification WhatsApp ne part réellement**, silencieusement (le code ne fait jamais échouer l'action métier associée — comportement voulu — mais personne n'est alerté de l'échec réel). Si WhatsApp est un canal de communication considéré important pour le lancement, vérifier le statut du compte WhatsApp Business Wasel/Meta (Meta Business Manager → statut des templates, mode développement vs production, numéros de test autorisés) **avant l'ouverture au public**.

**6.2 — non-blocage des rappels/notifications à délai** : vérifié sur le cron "mission sans Œil 12h" (`*/30 * * * *`) avec 2 missions orphelines simultanées — les deux ont reçu leur notification admin au même tick, `stale_notified_at` renseigné pour les deux, aucun blocage de l'une par l'absence de réaction sur l'autre. Architecture généralisable : tous les crons de rappel suivent le même patron (SELECT frais + traitement + marquage, jamais d'attente d'une réponse humaine) — vérifié par lecture de code sur l'ensemble des crons (`late_start`, `reminders`, `stale_missions`, `mission_edit_expiry`, `ticket_auto_resolve`). ✅

**6.3 — notification in-app** : vérifié empiriquement via navigateur (compte client de test, panneau de notifications réel) — l'ouverture du panneau déclenche bien `PUT /api/users/notifications/read` (HTTP 200 confirmé sur le réseau), et un clic à l'extérieur du panneau le referme bien (contenu du panneau disparaît de l'arbre DOM/accessibilité). ✅

---

## Catégorie 7 — Tickets de support

| # | Scénario | Attendu | Observé | Statut |
|---|---|---|---|---|
| 7.1 | Ticket normal, admin répond, pas de réponse utilisateur → auto-résolution après délai (72h réel, testé à 0.4h/24min réduit, vrai tick cron horaire) | status=resolved, resolved_by=NULL, message système | status=resolved, resolved_by=null, message système "Ticket résolu automatiquement après 72h sans réponse de votre part." ajouté | ✅ |
| 7.2 | Ticket `is_urgent=true` (catégorie 'urgence'), même scénario | NE DOIT JAMAIS auto-résoudre | status reste in_progress malgré le délai largement dépassé (confirmé au même tick que 7.1) | ✅ |
| 7.3 | Ticket répondu par l'utilisateur après auto-résolution | doit se rouvrir | réponse client sur le ticket 7.1 (déjà résolu) → status repasse in_progress | ✅ |

---

## Bugs trouvés, corrigés et re-testés

### Bug 1 — Auto-réassignation fantôme après un transfert 'before' (scénario 2.9)
**Constat empirique** : un Œil signalant un empêchement 'before' (avant démarrage) sans qu'aucun nouveau candidat ne se manifeste se voyait automatiquement **réassigné à sa propre mission** par le cron de sélection (`*/2min`) — via sa propre ligne `mission_interests` (posée avant sa première embauche), jamais nettoyée. Le cas 'during' était protégé par accident (cooldown posé uniquement pour ce type de transfert), pas 'before'.
**Correction** : `POST /:id/transfer` supprime désormais la ligne `mission_interests` de l'Œil transférant, immédiatement après la transition, quel que soit le type.
**Fichier** : `src/routes/missions.js`. **Commit** : `bdd2d67`.
**Re-test** : scénarios 2.9, 3.1, 3.3 tous re-vérifiés après correctif avec des comptes frais — comportement correct confirmé (aucune auto-réassignation, meilleur/seul candidat réel sélectionné).

### Bug 2 — Fraude financière via faux code promo gratuit (scénario 9.2)
**Constat empirique** : `POST /missions` faisait confiance à `promo_code` + `price=0` + `platform_amount` envoyés directement par le client, sans jamais vérifier que le code existait. Exploité empiriquement : un code totalement fictif (`CODE_QUI_NEXISTE_PAS_XYZ123`) + `platform_amount=99999` a produit une **vraie** dépense de 99999 MAD en catégorie Promotions et un paiement fictif à l'Œil.
**Correction** : le code est désormais re-validé côté serveur (existe, actif, `type='free'`, non expiré, quota par utilisateur respecté) et le montant utilisé est **toujours** celui de `promo_codes.platform_amount` en base, jamais la valeur envoyée par le client.
**Fichier** : `src/routes/missions.js`. **Commit** : `bdd2d67`.
**Re-test** : re-tentative de l'exploit après correctif → HTTP 400 "Code promo invalide pour une mission gratuite". Flux légitime (9.1, 9.2, 9.3) entièrement re-testé et conforme.

### Bug 3 — Perte de précision à la réintégration (scénario 5.3a)
**Constat empirique** : `reactivateWithCorrectiveEvent` encodait le score cible admin (0-100) sur l'échelle ±10 d'un événement normal (`round(cible/10)`), perdant jusqu'à 5 points à l'arrondi (cible 65 → 70 obtenu).
**Correction** : l'événement de reset stocke désormais le pourcentage cible directement ; `computeReliabilityScore` le traite comme une contribution exacte 0-100 au lieu de le faire passer par le clamp ±10 prévu pour les événements normaux. Formule mathématiquement identique à l'ancienne pour tout événement non-reset (vérifié).
**Fichier** : `src/utils/reliabilityScore.js`. **Commit** : `7a19c74`.
**Re-test** : cibles 65, 63, 92, 100 → toutes exactes. Cibles <55 plafonnées à 55 par le plancher de protection débutant — comportement intentionnel préexistant, non affecté par ce correctif.

---

## Gaps produit identifiés (non corrigés — décision requise)

### 1. Œil désactivé avec mission active en cours (scénario 10.3)
Aucun mécanisme (cron ou route) ne surveille les missions `active`/`en_route` dont l'Œil assigné passe à `is_active=false`. Contrairement au cas "mission encore `assigned`" (couvert indirectement par le cron H+30 late-start, mais avec une pénalité de -100 MAD + -20 fiabilité qui contredirait "aucune pénalité" pour une désactivation non fautive), une mission déjà **active** reste bloquée indéfiniment : l'Œil ne peut plus agir dessus (401 sur toute requête), aucune autre logique ne la reprend, et **personne n'est notifié** de la situation.
Il s'agit d'une fonctionnalité absente plutôt que d'un bug dans du code existant — la corriger implique un choix produit (bloquer la désactivation si mission active en cours ? déclencher un transfert automatique sans pénalité ? notifier l'admin uniquement ?) qui dépasse le cadre d'un correctif de bug. Signalé ici pour décision plutôt que résolu unilatéralement.

### 2. Intégration WhatsApp (Wasel/Meta) actuellement non fonctionnelle (catégorie 6.1)
Voir détail dans la section Catégorie 6 ci-dessus. Diagnostiqué comme un problème externe (compte Wasel/Meta Business), pas un bug de code — confirmé par un appel direct à l'API Wasel hors application, qui échoue identiquement. **Recommandation : vérifier le compte Wasel/Meta Business Manager avant le lancement**, si WhatsApp est un canal jugé important.

---

## Réconciliation financière globale (tous comptes de test de cette session)

Pour chaque compte de test ayant eu un mouvement financier durant cette session : `SUM(wallet_transactions credit) − SUM(debit)` comparé au solde réel en base.

| Compte | Rôle | Total crédit | Total débit | Solde théorique | Solde réel | Écart |
|---|---|---|---|---|---|---|
| s_client_* | client | 2470.00 | 0.00 | 2470.00 | 2470.00 | 0.00 ✅ |
| s_oeil0_* | oeil | 350.33 | 0.00 | 350.33 | 350.33 | 0.00 ✅ |
| s_oeil1_* | oeil | 232.90 | 0.00 | 232.90 | 232.90 | 0.00 ✅ |
| s_oeil2_* | oeil | 136.77 | 0.00 | 136.77 | 136.77 | 0.00 ✅ |
| s_oeil4_* | oeil | 224.00 | 0.00 | 224.00 | 224.00 | 0.00 ✅ |
| s4_oeil4_* | oeil | 240.00 | 0.00 | 240.00 | 240.00 | 0.00 ✅ |
| s4_oeil5_* | oeil | 440.00 | 0.00 | 440.00 | 440.00 | 0.00 ✅ |
| s5_final_* | oeil | 240.00 | 0.00 | 240.00 | 240.00 | 0.00 ✅ |
| s5_oeil0_* | oeil | 448.00 | 0.00 | 448.00 | 448.00 | 0.00 ✅ |
| audit2_client_* (session 07-17, réutilisé) | client | 4365.00 | 0.00 | 4365.00 | 4365.00 | 0.00 ✅ |
| audit2_oeil0_* (idem) | oeil | 240.00 | 200.00 | 40.00 | 40.00 | 0.00 ✅ |
| audit2_oeil1_* (idem) | oeil | 192.00 | 0.00 | 192.00 | 192.00 | 0.00 ✅ |
| audit2_fixb_* (idem) | oeil | 140.00 | 100.00 | 40.00 | 40.00 | 0.00 ✅ |
| audit2_fix2b_* (idem) | oeil | 140.00 | 100.00 | 40.00 | 40.00 | 0.00 ✅ |

**14/15 comptes réconcilient parfaitement (écart 0.00).**

**⚠️ 1 écart hors-scope détecté** : `me002-oeil-1784376295866-tn4y7@test.local` (compte d'une session d'audit **antérieure** au 2026-07-13/17, jamais créé ni touché par aucun script de cette session) — solde réel 100.00 MAD, **zéro ligne `wallet_transactions`**. Deuxième occurrence confirmée de la même anomalie que celle déjà signalée sur `yassine@gmail.com` (compte réel, écart -2893.20 MAD, session 2026-07-17) : un solde présent en base sans mouvement de ledger correspondant. Toujours hors du périmètre de cet audit (compte non touché), mais cette deuxième occurrence indépendante renforce la recommandation d'une passe de réconciliation dédiée sur **tous** les comptes de la plateforme avant le lancement public — pas seulement les comptes de test.

---

## Synthèse finale

- **~48 scénarios testés** sur les 10 catégories demandées (dont plusieurs sous-cas par scénario numéroté, ex. 2.5a/2.5b, 9.2-bis).
- **✅ Conformes** : toutes les catégories 1 à 5, 7, 8, 9, 10, et les volets techniques de la catégorie 6 (déclenchement, non-blocage, comportement in-app).
- **❌ 3 bugs réels trouvés, diagnostiqués, corrigés, re-testés, commités et poussés sur `origin/main`** :
  1. Auto-réassignation fantôme après transfert 'before' sans remplaçant (`bdd2d67`)
  2. Fraude financière via faux code promo gratuit — dépense arbitraire fabriquable (`bdd2d67`)
  3. Perte de précision du score à la réintégration admin (`7a19c74`)
- **🔲 2 gaps produits signalés, non corrigés** (décisions requises, hors périmètre d'un simple correctif) :
  1. Aucune réaffectation automatique d'une mission active dont l'Œil est désactivé
  2. Intégration WhatsApp actuellement 100% non fonctionnelle (problème externe Wasel/Meta, pas un bug de code)
- **⚠️ 1 observation mineure sans impact** : ligne `mission_transfer_chain` orpheline créée pour toute mission atteignant 'active' (universel, pas spécifique au cas 'before' testé en 2.8) — inerte, non lue par la logique de paiement.
- **Réconciliation financière** : 14/15 comptes de test exacts au centime ; 1 écart hors-scope (compte pré-existant d'une session antérieure) qui fait écho à une anomalie déjà connue sur un compte réel — recommandation de réconciliation globale avant lancement.
- **Hygiène (non corrigée, hors périmètre)** : suppression non commitée de deux fichiers déjà renommés (`reliability.js`→`reliabilityRoutes.js`/`reliabilityScore.js`), sans impact fonctionnel.

```
git log --oneline -5
bdd2d67 Fix two integrity bugs found during full scenario audit
7a19c74 Fix reactivation score precision loss (audit scenario 5.3a)
9b40b19 Route the five-star bonus credit through walletService (last of the 4 duplicates found)
...

git push origin main
9b40b19..bdd2d67  main -> main   (confirmé)
```

Scripts de test conservés dans `backend/_audit/` (non commités, non versionnés) pour référence/relecture — peuvent être supprimés sans impact sur l'application.
