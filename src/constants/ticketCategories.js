// Constantes serveur pour les tickets de support. Le détail complet des catégories/
// sous-catégories (libellés, redirections, pertinence mission) vit côté frontend dans
// shoofly-react/src/constants/ticketCategories.js — ici on ne garde que ce dont les
// routes ont besoin pour valider/orchestrer.

const VALID_CATEGORIES = [
  'mission', 'paiement', 'compte', 'facturation', 'verification', 'securite',
  'application', 'assistance_technique', 'confidentialite', 'reclamation',
  'suggestion', 'urgence', 'autre',
];

const URGENT_CATEGORY = 'urgence';

// Catégories pour lesquelles une mission liée déclenche under_surveillance=true,
// comme le faisait l'ancien système de signalement (mission_problem_reports).
const SURVEILLANCE_CATEGORIES = ['mission', 'reclamation', 'urgence'];

module.exports = { VALID_CATEGORIES, URGENT_CATEGORY, SURVEILLANCE_CATEGORIES };
