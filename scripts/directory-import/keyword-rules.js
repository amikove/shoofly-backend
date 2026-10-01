// Règles de reclassement par mots-clés du nom (FR + AR) — Chantier SEO annuaire, décision BOSS #2
// (2026-09-30) : "Applique ce reclassement à TOUS les buckets génériques, pas seulement 'hospital'."
//
// Principe : le nom d'un établissement est un signal plus fiable que la taxonomie brute de la
// source (Overture 'hospital' est prouvé bruité à 68%, voir RAPPORT_ETUDE_SEO_DONNEES.md §5.3).
// Ce module ne reçoit QUE des fiches déjà filtrées sur le périmètre santé par la taxonomie source
// (health_care / Health and Medicine) — il ne sert donc qu'à RECLASSER à l'intérieur de la santé,
// jamais à décider si une fiche est santé ou non.
//
// Ordre des règles = ordre de priorité (la première catégorie qui matche gagne), du plus
// spécifique au plus générique. 'autres_sante' est le repli si rien ne matche (décision #3 de
// l'étude initiale : ce qui reste ambigu n'est jamais inventé).

const RULES = [
  { category: 'radiologie', keywords: [
    'radiologie', 'radiologue', 'imagerie', 'scanner', 'irm', 'echographie', 'radiodiagnostic',
    'اشعة', 'تصوير طبي',
  ] },
  { category: 'laboratoires', keywords: [
    'labo', 'laboratoire', 'analyses medicales', 'analyse medicale', 'biologie medicale',
    'مختبر', 'تحاليل',
  ] },
  { category: 'dentistes', keywords: [
    'dentaire', 'dentiste', 'orthodont', 'implantologie', 'stomatolog', 'parodont',
    'اسنان', 'طبيب اسنان',
  ] },
  { category: 'kinesitherapie', keywords: [
    'kinesither', 'kine ', ' kine', 'physiotherap', 'reeducation', 'ergotherap',
    'علاج طبيعي', 'تأهيل',
  ] },
  { category: 'ophtalmologie', keywords: [
    'ophtalmolog', 'ophtalmo', 'optometri',
    'طب العيون', 'جراحة العيون',
  ] },
  { category: 'gynecologie', keywords: [
    'gyneco', 'obstetri', 'maternite', 'sage-femme', 'sage femme',
    'امراض النساء', 'نساء وتوليد', 'التوليد',
  ] },
  { category: 'pediatrie', keywords: [
    'pediatr',
    'طب الاطفال', 'طبيب اطفال',
  ] },
  { category: 'sante_mentale', keywords: [
    'psychiatr', 'psycholog', 'psychotherap', 'pedopsychiatr',
    'الصحة النفسية', 'طبيب نفسي', 'اخصائي نفسي',
  ] },
  { category: 'medecines_douces', keywords: [
    'osteopath', 'acupunctur', 'naturopath', 'chiropract', 'reflexolog', 'homeopath',
    'الطب البديل', 'الطب التكميلي',
  ] },
  { category: 'urgences', keywords: [
    'ambulance', 'samu', 'urgences medicales', 'urgence medicale',
    'اسعاف', 'الاسعافات',
  ] },
  { category: 'cliniques', keywords: [
    'polyclinique', 'clinique',
    'مصحة', 'المصحة',
  ] },
  { category: 'hopitaux', keywords: [
    'hopital', 'chu ', ' chu', 'centre hospitalier', 'hopital universitaire',
    'مستشفى', 'المستشفى',
  ] },
  { category: 'specialites_medicales', keywords: [
    'cardiolog', 'dermatolog', 'urolog', 'endocrinolog', 'gastro-enterolog', 'gastroenterolog',
    'neurolog', 'oncolog', 'orl ', ' orl', 'oto-rhino', 'rhumatolog', 'chirurgie', 'chirurgien',
    'podolog', 'audiolog', 'pneumolog', 'nephrolog', 'proctolog', 'angiolog', 'allerg',
    'انف واذن وحنجرة', 'امراض القلب', 'الجلدية', 'المسالك البولية', 'الجراحة', 'الغدد الصماء',
  ] },
  { category: 'medecine_generale', keywords: [
    'medecin generaliste', 'cabinet medical', 'generaliste', 'medecine generale', 'medecine interne',
    'طب عام', 'طبيب عام',
  ] },
];

const FALLBACK_CATEGORY = 'autres_sante';

// Exclusion (décision BOSS, 2026-09-30, Phase 2 bis) : une fiche dont le NOM contient un de ces
// marqueurs n'est pas un établissement — le plus souvent un arrêt de transport ou une infra qui
// porte le nom d'un établissement proche (ex. trouvé en Phase 2 : un arrêt de tramway nommé
// d'après l'hôpital Moulay Youssef, classé 'hopitaux' par erreur — voir RAPPORT_PHASE2_DONNEES.md
// §B.2). Vérifiée AVANT toute classification, sur santé ET administrations (même liste, même
// fonction) : ce n'est pas un problème propre à la santé.
// NOTE (trouvé en testant sur le fichier MTNRA, Phase 2 bis) : un marqueur ' gare '/'gare de' nu
// a été essayé puis RETIRÉ — il excluait à tort de vraies fiches dont "Gare" fait partie du nom
// propre de l'établissement (ex. "Poste Maroc Rabat Gare", une vraie agence postale près de la
// gare ferroviaire de Rabat ; "Pharmacie Gare Agdal", une vraie pharmacie). Seules les formes
// composées spécifiques ('gare ferroviaire', 'gare routiere'), qui ne matchent que la gare
// elle-même, sont conservées.
const EXCLUSION_KEYWORDS = [
  'tramway', 'tram ', ' tram', 'station de tram', 'arret de tram', 'arret tram',
  'station', 'arret', 'terminus', 'parking', 'gare routiere', 'gare ferroviaire',
  'محطة', 'موقف', 'محطة الطرامواي', 'محطة القطار',
];

function isExcludedByKeyword(name) {
  const normalizedName = normalizeForMatch(name);
  for (const kw of EXCLUSION_KEYWORDS) {
    if (normalizedName.includes(normalizeCore(kw))) return { excluded: true, matchedKeyword: kw };
  }
  return { excluded: false, matchedKeyword: null };
}

// Normalisation : minuscule, accents latins retirés (NFD), tashkeel arabe retiré, variantes de
// alef/yeh/teh marbuta unifiées — pour que la recherche par sous-chaîne soit robuste aux
// variations d'écriture (ex. "généraliste" / "GENERALISTE", "مُستشفى" / "مستشفي").
// Coeur de normalisation, appliqué IDENTIQUEMENT au nom et aux mots-clés (sinon une différence de
// forme entre les deux — ex. alef maksure 'ى' non convertie côté mot-clé — fait rater un match
// pourtant correct). Piège vérifié en test : 'مستشفى' (mot-clé) ne matchait pas 'مستشفى الشيخ...'
// (nom) une fois le nom normalisé, tant que le mot-clé lui-même n'était pas passé par la même
// fonction.
function normalizeCore(s) {
  let out = (s || '').toLowerCase();
  out = out.normalize('NFD').replace(/[̀-ͯ]/g, ''); // accents latins
  out = out.replace(/[ً-ٰٟ]/g, ''); // tashkeel arabe
  out = out.replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
  return out;
}

function normalizeForMatch(name) {
  return ' ' + normalizeCore(name) + ' '; // espaces de bord pour matcher les mots-clés bordés d'espace (' orl', 'chu ')
}

// Retourne { category, matchedKeyword } — matchedKeyword est loggé pour audit (pourquoi ce
// classement), jamais affiché à l'utilisateur final.
function classifyByName(name) {
  const normalizedName = normalizeForMatch(name);
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (normalizedName.includes(normalizeCore(kw))) return { category: rule.category, matchedKeyword: kw };
    }
  }
  return { category: FALLBACK_CATEGORY, matchedKeyword: null };
}

module.exports = { RULES, FALLBACK_CATEGORY, EXCLUSION_KEYWORDS, normalizeForMatch, normalizeCore, classifyByName, isExcludedByKeyword };
