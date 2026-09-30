// Règles de reclassement par mots-clés du nom — administrations (Phase 2 bis, décision BOSS #2,
// 2026-09-30). Même principe que keyword-rules.js (santé) : le nom est le signal fiable, la source
// (MTNRA/Overture/Foursquare/OSM) ne fournit pas de colonne "type d'administration" exploitable.
// Réutilise normalizeCore/isExcludedByKeyword de keyword-rules.js (mêmes marqueurs d'exclusion —
// tram/station/parking — s'appliquent aussi aux administrations, pas seulement à la santé).
const { normalizeCore } = require('./keyword-rules');

const ADMIN_RULES = [
  // Phase 3, décision #1 (2026-09-30) : reclassé en tête de liste (avant tout mot-clé
  // administration) — un dispensaire/centre de santé public n'est pas une administration, c'est un
  // lieu d'attente santé (catégorie 'centres_sante_publics', domain='sante', voir schema.js).
  { category: 'centres_sante_publics', keywords: [
    'dispensaire', 'centre de sante', 'centre medical municipal', 'csu ', ' csu',
    'مستوصف', 'مركز صحي',
  ] },
  { category: 'cnss', keywords: [
    'cnss', 'caisse nationale de securite sociale', 'caisse nationale de sécurité sociale',
    'الصندوق الوطني للضمان الاجتماعي',
  ] },
  { category: 'barid', keywords: [
    'barid al maghrib', 'barid', 'poste maroc', 'agence postale', 'al barid',
    'بريد المغرب', 'البريد',
  ] },
  { category: 'conservation_fonciere', keywords: [
    'conservation fonciere', 'ancfcc', 'cadastre', 'agence nationale de la conservation fonciere',
    'المحافظة العقارية', 'المسح العقاري',
  ] },
  { category: 'impots', keywords: [
    'direction generale des impots', 'impots', 'tresorerie', 'perception', 'recette des impots',
    'الضرائب', 'الخزينة العامة', 'القباضة',
  ] },
  { category: 'eau_electricite', keywords: [
    'redal', 'lydec', 'onee', 'radeema', 'radeef', 'amendis',
    "distribution d'eau et d'electricite", 'distribution deau et delectricite',
    'وكالة توزيع الماء والكهرباء', 'الماء والكهرباء',
  ] },
  { category: 'prefecture', keywords: [
    'prefecture', 'pachalik', 'caidat', 'wilaya',
    'عمالة', 'باشوية', 'قيادة', 'ولاية',
  ] },
  { category: 'arrondissement_etat_civil', keywords: [
    'arrondissement', 'etat civil', 'bureau d etat civil',
    'مقاطعة', 'الحالة المدنية',
  ] },
  { category: 'commissariat', keywords: [
    'commissariat', 'surete nationale', 'district de police', 'brigade de police',
    'مركز الشرطة', 'الأمن الوطني', 'المفوضية',
  ] },
  { category: 'tribunal', keywords: [
    'tribunal', "cour d'appel", 'cour dappel', 'cour de cassation', 'justice de paix', 'centre de juge resident',
    'المحكمة', 'محكمة الاستئناف', 'المجلس الأعلى',
  ] },
  { category: 'banque', keywords: [
    'banque', 'bank', 'credit agricole', 'credit populaire', 'credit du maroc', 'attijari', 'bmce',
    'cih', 'albarid bank', 'al barid bank',
    'بنك', 'القرض الفلاحي', 'التجاري وفا',
  ] },
];

function classifyAdminByName(name) {
  const normalizedName = ' ' + normalizeCore(name) + ' ';
  for (const rule of ADMIN_RULES) {
    for (const kw of rule.keywords) {
      if (normalizedName.includes(normalizeCore(kw))) return { category: rule.category, matchedKeyword: kw };
    }
  }
  return { category: 'autres_administrations', matchedKeyword: null };
}

module.exports = { ADMIN_RULES, classifyAdminByName };
