// ── Seed initial de la table `subcategory_min_prices` (schema.js, initDb) ──────────────────
//
// SOURCE DE VÉRITÉ RUNTIME = la table `subcategory_min_prices`, lue via
// `utils/subcategoryMinPrices.js` (cache mémoire 60 s + invalidation à l'écriture). Ce fichier
// ne sert QU'À amorcer la table la première fois (INSERT ... ON CONFLICT DO NOTHING) : une fois
// la table peuplée, modifier une valeur ici n'a plus AUCUN effet — l'admin édite les planchers
// depuis Paramètres › 💰 Tarification (PUT /api/users/admin/subcategory-min-prices). Ne jamais
// lire cette constante dans de la logique métier.
//
// Historique : chantier D1 (audit régression 360° v4, 2026-08-31) avait porté ces 45 planchers
// NOMMÉS en dur dans `constants/missionCategories.js` (SUBCATEGORY_MIN_PRICES) ET
// `shoofly-react/.../NewMissionModal.jsx` (MIN_PRICES), maintenus synchro à la main. Ce chantier
// (2026-09-10) les déplace en base, source unique, éditables sans redéploiement.
//
// Les 4 dernières lignes (`_immobilier`, `_file_attente`, `_audit`, `_personnalisee`) sont les
// « défauts par type » : le plancher appliqué quand la sous-catégorie choisie n'a pas de
// plancher nommé (immobilier / personnalisée sans sous-catégorie, ou « … — Autre » /
// « Autre — À préciser »). Avant ce chantier ils n'existaient QUE côté frontend (MIN_PRICES
// `_immobilier` etc.) : un appel API direct hors formulaire n'était planché qu'au `min_price`
// global (80). Décision de session (Option C) : le serveur les applique désormais aussi, via ce
// même mécanisme (mêmes table / cache / écran admin). La clé préfixée `_` ne peut pas entrer en
// collision avec une vraie sous-catégorie (toutes en toutes lettres, aucune ne commence par `_`).
// `_default` (50) du frontend n'est PAS porté : `body('type').isIn([...4 types])` garantit que
// l'un des 4 défauts ci-dessus s'applique toujours, et `Math.max(min_price=80, 50)` vaudrait de
// toute façon le repli global.
//
// `category` d'une ligne sentinelle = le type lui-même (l'écran admin les regroupe en détectant
// le préfixe `_`).

module.exports = [
  // ── Immobilier (6) ──────────────────────────────────────────────
  { subcategory: 'Airbnb',                        category: 'immobilier',    min_price: 170 },
  { subcategory: 'Booking',                       category: 'immobilier',    min_price: 170 },
  { subcategory: 'Avito',                         category: 'immobilier',    min_price: 129 },
  { subcategory: 'Mubawab',                       category: 'immobilier',    min_price: 129 },
  { subcategory: 'Agence immobilière',            category: 'immobilier',    min_price: 149 },
  { subcategory: 'Particulier',                   category: 'immobilier',    min_price: 129 },

  // ── File d'attente — Véhicules & Transport / Centres de santé (4) ─
  { subcategory: 'Centre de visite technique',    category: 'file_attente',  min_price: 79 },
  { subcategory: 'Hôpital & clinique',            category: 'file_attente',  min_price: 99 },
  { subcategory: 'Cabinet de spécialiste',        category: 'file_attente',  min_price: 85 },
  { subcategory: 'Laboratoire',                   category: 'file_attente',  min_price: 69 },

  // ── File d'attente — Administrations (11) ────────────────────────
  { subcategory: 'CNSS',                          category: 'file_attente',  min_price: 129 },
  { subcategory: 'ANCFCC',                        category: 'file_attente',  min_price: 109 },
  { subcategory: "Services d'état civil",         category: 'file_attente',  min_price: 85 },
  { subcategory: 'Tribunal',                      category: 'file_attente',  min_price: 109 },
  { subcategory: "Centre d'immatriculation",      category: 'file_attente',  min_price: 99 },
  { subcategory: 'Préfectures / Annexes administratives', category: 'file_attente', min_price: 85 },
  { subcategory: 'Douane',                        category: 'file_attente',  min_price: 129 },
  { subcategory: 'Bureau des passeports / Cartes nationales', category: 'file_attente', min_price: 99 },
  { subcategory: 'Adoul / Notaires',             category: 'file_attente',  min_price: 109 },
  { subcategory: "CRI / Centres régionaux d'investissement", category: 'file_attente', min_price: 109 },
  { subcategory: 'Impôts (DGI)',                  category: 'file_attente',  min_price: 99 },

  // ── File d'attente — Services publics / Consulats / Banques / Éducation (14) ─
  { subcategory: 'ONEE',                          category: 'file_attente',  min_price: 85 },
  { subcategory: 'REDAL',                         category: 'file_attente',  min_price: 85 },
  { subcategory: 'RADEEMA',                       category: 'file_attente',  min_price: 85 },
  { subcategory: 'Consulat étranger',             category: 'file_attente',  min_price: 169 },
  { subcategory: 'Centre de visas',               category: 'file_attente',  min_price: 149 },
  { subcategory: 'Attijariwafa',                  category: 'file_attente',  min_price: 69 },
  { subcategory: 'CIH Bank',                      category: 'file_attente',  min_price: 69 },
  { subcategory: 'Banque Populaire',              category: 'file_attente',  min_price: 69 },
  { subcategory: 'BMCE',                          category: 'file_attente',  min_price: 69 },
  { subcategory: 'BMCI',                          category: 'file_attente',  min_price: 69 },
  { subcategory: 'Al Barid Bank',                 category: 'file_attente',  min_price: 69 },
  { subcategory: 'Inscription universitaire',     category: 'file_attente',  min_price: 99 },
  { subcategory: 'École privée',                  category: 'file_attente',  min_price: 85 },
  { subcategory: 'Bourse & dossier étudiant',     category: 'file_attente',  min_price: 99 },

  // ── Audit (6) ───────────────────────────────────────────────────
  { subcategory: "Restaurant (Temps d'attente, Propreté, Qualité du service)", category: 'audit', min_price: 209 },
  { subcategory: 'Café (Accueil, Rapidité, Propreté)',                         category: 'audit', min_price: 169 },
  { subcategory: 'Hôtel (Check-in, Service client, Propreté)',                 category: 'audit', min_price: 299 },
  { subcategory: 'Salle de sport (Accueil commercial, État des équipements, Suivi coachs)', category: 'audit', min_price: 249 },
  { subcategory: 'Concession automobile (Qualité vendeur, Temps de prise en charge, Suivi commercial)', category: 'audit', min_price: 249 },
  { subcategory: 'Agence immobilière (Qualité accueil, Réactivité, Compétence commerciale)', category: 'audit', min_price: 209 },

  // ── Personnalisée (4) ───────────────────────────────────────────
  { subcategory: 'Présence physique',            category: 'personnalisee', min_price: 85 },
  { subcategory: 'Accompagnement',               category: 'personnalisee', min_price: 129 },
  { subcategory: 'Vérification',                 category: 'personnalisee', min_price: 99 },
  { subcategory: 'Livraison',                    category: 'personnalisee', min_price: 69 },

  // ── Défauts par type — sous-catégorie sans plancher nommé (4) ────
  { subcategory: '_immobilier',                  category: 'immobilier',    min_price: 129 },
  { subcategory: '_file_attente',                category: 'file_attente',  min_price: 85 },
  { subcategory: '_audit',                       category: 'audit',         min_price: 209 },
  { subcategory: '_personnalisee',               category: 'personnalisee', min_price: 85 },
];
