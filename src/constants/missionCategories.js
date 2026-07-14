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

module.exports = { MISSION_SUBCATEGORIES, isValidSubcategory };
