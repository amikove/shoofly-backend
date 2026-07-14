// Options des <select> du formulaire d'inscription — copie serveur de la source de vérité
// frontend (shoofly-react/src/pages/auth/Register.jsx). Dette technique assumée : dupliquée
// manuellement, comme villes.js — si les options changent côté frontend, répercuter ici.
const PROFIL_OPTIONS = [
  'Particulier', "Entrepreneur / Chef d'entreprise", 'Professionnel / Salarié',
  'Expatrié / Non-résident (MRE)', 'Étudiant', 'Investisseur immobilier',
  'Profession libérale (avocat, médecin, architecte...)', 'Autre',
];

const SITUATION_OPTIONS = [
  'Étudiant', 'Salarié', 'Freelance', 'Auto-entrepreneur',
  "En recherche d'emploi", 'Retraité', 'Autre',
];

const MOTIVATION_OPTIONS = [
  'Revenu complémentaire', 'Revenu principal', 'Expérience professionnelle', 'Flexibilité', 'Autre',
];

const USAGE_REASON_OPTIONS = [
  'Gagner du temps', 'Éviter un déplacement', 'Vérifier avant un achat',
  'Gérer une démarche administrative', 'Superviser une activité à distance', 'Autre',
];

const USAGE_FREQUENCY_OPTIONS = [
  'Une seule fois', 'Quelques fois par an', 'Une fois par mois',
  'Plusieurs fois par mois', 'Chaque semaine',
];

const DISPONIBILITE_OPTIONS = ['En semaine', 'Soirs', 'Week-ends', 'Temps plein'];

module.exports = {
  PROFIL_OPTIONS, SITUATION_OPTIONS, MOTIVATION_OPTIONS,
  USAGE_REASON_OPTIONS, USAGE_FREQUENCY_OPTIONS, DISPONIBILITE_OPTIONS,
};
