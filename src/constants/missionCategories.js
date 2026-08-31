// Sous-catégories de mission valides par type — copie serveur de la source de vérité
// frontend (shoofly-react/src/components/missions/NewMissionModal.jsx, const CATEGORIES).
// Dette technique assumée : dupliquée manuellement, comme villes.js — si CATEGORIES change
// côté frontend, répercuter le changement ici.
const MISSION_SUBCATEGORIES = {
  immobilier: ['Airbnb', 'Booking', 'Avito', 'Mubawab', 'Agence immobilière', 'Particulier', 'Autre'],
  file_attente: [
    'Véhicules & Transport — Centre de visite technique',
    'Véhicules & Transport — Autre',
    'Centres de santé — Hôpital & clinique',
    'Centres de santé — Cabinet de spécialiste',
    'Centres de santé — Laboratoire',
    'Centres de santé — Autre',
    'Administrations — CNSS',
    'Administrations — ANCFCC',
    "Administrations — Services d'état civil",
    'Administrations — Tribunal',
    "Administrations — Centre d'immatriculation",
    'Administrations — Préfectures / Annexes administratives',
    'Administrations — Douane',
    'Administrations — Bureau des passeports / Cartes nationales',
    'Administrations — Adoul / Notaires',
    "Administrations — CRI / Centres régionaux d'investissement",
    'Administrations — Impôts (DGI)',
    'Administrations — Autre',
    'Services publics — ONEE',
    'Services publics — REDAL',
    'Services publics — RADEEMA',
    'Services publics — Autre',
    'Consulats et visas — Consulat étranger',
    'Consulats et visas — Centre de visas',
    'Consulats et visas — Autre',
    'Banques — Attijariwafa',
    'Banques — CIH Bank',
    'Banques — Banque Populaire',
    'Banques — BMCE',
    'Banques — BMCI',
    'Banques — Al Barid Bank',
    'Banques — Autre',
    'Éducation — Inscription universitaire',
    'Éducation — École privée',
    'Éducation — Bourse & dossier étudiant',
    'Éducation — Autre',
    'Autre — À préciser',
  ],
  audit: [
    "Restaurant (Temps d'attente, Propreté, Qualité du service)",
    'Café (Accueil, Rapidité, Propreté)',
    'Hôtel (Check-in, Service client, Propreté)',
    'Salle de sport (Accueil commercial, État des équipements, Suivi coachs)',
    'Concession automobile (Qualité vendeur, Temps de prise en charge, Suivi commercial)',
    'Agence immobilière (Qualité accueil, Réactivité, Compétence commerciale)',
  ],
  personnalisee: ['Présence physique', 'Accompagnement', 'Vérification', 'Livraison', 'Autre'],
};

// Sous-catégorie optionnelle pour immobilier/personnalisee, requise côté frontend pour
// file_attente/audit (non ré-imposé ici — on valide seulement que la valeur fournie,
// si elle l'est, appartient bien à la liste du type donné).
function isValidSubcategory(type, subcategory) {
  if (!subcategory) return true;
  const list = MISSION_SUBCATEGORIES[type];
  if (!list) return false;
  return list.includes(subcategory);
}

// Planchers tarifaires par sous-catégorie — copie serveur de MIN_PRICES
// (shoofly-react/src/components/missions/NewMissionModal.jsx). Même dette de duplication
// manuelle que MISSION_SUBCATEGORIES ci-dessus : toute modification de prix côté frontend
// DOIT être répercutée ici, et inversement. Voir aussi le commentaire jumeau dans
// NewMissionModal.jsx (bloc MIN_PRICES).
//
// Portée volontairement limitée aux entrées NOMMÉES. Les cinq défauts par type du frontend
// (_immobilier, _file_attente, _audit, _personnalisee, _default) ne sont PAS portés : côté
// serveur, une sous-catégorie absente de cette table — y compris les « Autre » / « À préciser »
// — retombe sur le plancher global configurable `min_price` (settings, défaut 80 MAD), qui
// reste la validation existante inchangée. Voir prepareMissionInsert (routes/missions.js).
const SUBCATEGORY_MIN_PRICES = {
  // Immobilier
  'Airbnb': 170,
  'Booking': 170,
  'Avito': 129,
  'Mubawab': 129,
  'Agence immobilière': 149,
  'Particulier': 129,
  // File d'attente — Véhicules & Transport / Centres de santé
  'Centre de visite technique': 79,
  'Hôpital & clinique': 99,
  'Cabinet de spécialiste': 85,
  'Laboratoire': 69,
  // File d'attente — Administrations
  'CNSS': 129,
  'ANCFCC': 109,
  "Services d'état civil": 85,
  'Tribunal': 109,
  "Centre d'immatriculation": 99,
  'Préfectures / Annexes administratives': 85,
  'Douane': 129,
  'Bureau des passeports / Cartes nationales': 99,
  'Adoul / Notaires': 109,
  "CRI / Centres régionaux d'investissement": 109,
  'Impôts (DGI)': 99,
  // File d'attente — Services publics / Consulats / Banques / Éducation
  'ONEE': 85,
  'REDAL': 85,
  'RADEEMA': 85,
  'Consulat étranger': 169,
  'Centre de visas': 149,
  'Attijariwafa': 69,
  'CIH Bank': 69,
  'Banque Populaire': 69,
  'BMCE': 69,
  'BMCI': 69,
  'Al Barid Bank': 69,
  'Inscription universitaire': 99,
  'École privée': 85,
  'Bourse & dossier étudiant': 99,
  // Audit
  "Restaurant (Temps d'attente, Propreté, Qualité du service)": 209,
  'Café (Accueil, Rapidité, Propreté)': 169,
  'Hôtel (Check-in, Service client, Propreté)': 299,
  'Salle de sport (Accueil commercial, État des équipements, Suivi coachs)': 249,
  'Concession automobile (Qualité vendeur, Temps de prise en charge, Suivi commercial)': 249,
  'Agence immobilière (Qualité accueil, Réactivité, Compétence commerciale)': 209,
  // Personnalisée
  'Présence physique': 85,
  'Accompagnement': 129,
  'Vérification': 99,
  'Livraison': 69,
};

// Reproduit le parsing de getMinPrice côté frontend : les sous-catégories file_attente
// arrivent préfixées du libellé de groupe ('Consulats et visas — Consulat étranger',
// séparateur ' — ' = espace + tiret cadratin U+2014 + espace), alors que la table est
// indexée sur la clé nue. `.split(' — ').pop()` est un no-op pour les autres types (aucun
// libellé ne contient ce séparateur). Retourne null si la sous-catégorie n'a pas de
// plancher spécifique — l'appelant retombe alors sur le plancher global.
function getSubcategoryMinPrice(subcategory) {
  if (!subcategory) return null;
  const bare = subcategory.split(' — ').pop();
  return Object.prototype.hasOwnProperty.call(SUBCATEGORY_MIN_PRICES, bare)
    ? SUBCATEGORY_MIN_PRICES[bare]
    : null;
}

module.exports = { MISSION_SUBCATEGORIES, isValidSubcategory, SUBCATEGORY_MIN_PRICES, getSubcategoryMinPrice };
