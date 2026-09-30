// Étape 2 : fusion Overture + Foursquare (dédoublonnage nom normalisé + distance < 50 m, même
// méthode que la vérification intra-Overture de l'étude du 09-29) puis reclassement par mots-clés
// (keyword-rules.js) appliqué à TOUS les enregistrements, pas seulement l'ancien bucket 'hospital'
// (décision BOSS #2). Lecture des fichiers out/*_health.json produits par fetch-sources.js,
// écriture de out/merged.json. Aucune écriture DB ici.

const fs = require('fs');
const path = require('path');
const { classifyByName, normalizeCore, FALLBACK_CATEGORY, isExcludedByKeyword } = require('./keyword-rules');

const OUT_DIR = path.join(__dirname, 'out');
const MERGE_DISTANCE_M = 50;

// Repli quand le nom seul ne suffit pas à classer (ex. fiche purement nominative "Dr X Y") : on
// retombe sur un indice tiré de la taxonomie source, moins fiable (voir RAPPORT_ETUDE §5.3 sur le
// bucket 'hospital') mais mieux que 'autres_sante' par défaut quand un vrai indice existe.
const OVERTURE_TAXONOMY_HINT = {
  dental_clinic: 'dentistes', cosmetic_dentistry: 'dentistes', orthodontics: 'dentistes',
  periodontics: 'dentistes', pediatric_dentistry: 'dentistes', general_dentistry: 'dentistes',
  laboratory_testing: 'laboratoires',
  radiology: 'radiologie',
  physical_therapy: 'kinesitherapie', speech_therapy: 'kinesitherapie', prosthetics: 'kinesitherapie',
  vision_or_eye_care_clinic: 'ophtalmologie', optometry: 'ophtalmologie',
  obstetrics_and_gynecology: 'gynecologie', maternity_center: 'gynecologie',
  prenatal_and_perinatal_care: 'gynecologie', reproductive_perinatal_and_womens_care: 'gynecologie',
  pediatric_clinic: 'pediatrie',
  psychology: 'sante_mentale', psychiatry: 'sante_mentale', counseling: 'sante_mentale', psychotherapy: 'sante_mentale',
  naturopathic_medicine: 'medecines_douces', aromatherapy: 'medecines_douces', chiropractic: 'medecines_douces', reflexology: 'medecines_douces',
  ambulance_or_ems_service: 'urgences',
  hospital: 'hopitaux',
  surgery: 'specialites_medicales', oral_and_maxillofacial_surgery: 'specialites_medicales',
  plastic_and_reconstructive_surgery: 'specialites_medicales', surgery_center: 'specialites_medicales',
  dialysis_clinic: 'specialites_medicales', fertility_clinic: 'specialites_medicales',
  dermatology: 'specialites_medicales', cardiology: 'specialites_medicales', rheumatology: 'specialites_medicales',
  endocrinology: 'specialites_medicales', urology: 'specialites_medicales', gastroenterology: 'specialites_medicales',
  proctology: 'specialites_medicales', osteopathic_medicine: 'specialites_medicales', ear_nose_and_throat: 'specialites_medicales',
  audiology: 'specialites_medicales', pulmonology: 'specialites_medicales', neurology: 'specialites_medicales',
  neuropathology: 'specialites_medicales', oncology: 'specialites_medicales', orthopedics: 'specialites_medicales',
  podiatry: 'specialites_medicales', nursing: 'specialites_medicales',
  family_practice: 'medecine_generale', doctors_office: 'medecine_generale', internal_medicine: 'medecine_generale',
};

function fsqTaxonomyHint(labels) {
  if (!Array.isArray(labels)) return null;
  const FSQ_MAP = {
    'Health and Medicine > Dentist': 'dentistes',
    'Health and Medicine > Hospital': 'hopitaux',
    'Health and Medicine > Medical Lab': 'laboratoires',
    'Health and Medicine > Physician > Ophthalmologist': 'ophtalmologie',
    'Health and Medicine > Optometrist': 'ophtalmologie',
    'Health and Medicine > Emergency Service > Emergency Room': 'urgences',
    'Health and Medicine > Physician > Doctor\'s Office': 'medecine_generale',
    'Health and Medicine > Medical Center': 'autres_sante',
  };
  for (const label of labels) if (FSQ_MAP[label]) return FSQ_MAP[label];
  return null;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Nom normalisé pour la comparaison de doublons (distinct de normalizeCore de keyword-rules, qui
// vise le matching de mots-clés) : retire ponctuation/espaces multiples pour comparer une forme
// "canonique" du nom entre les deux sources.
function normalizeForDedup(name) {
  return normalizeCore(name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function classify(name, sourceHint) {
  const byName = classifyByName(name);
  if (byName.category !== FALLBACK_CATEGORY) return { category: byName.category, method: 'keyword', matched: byName.matchedKeyword };
  if (sourceHint) return { category: sourceHint, method: 'source_taxonomy_fallback', matched: null };
  return { category: FALLBACK_CATEGORY, method: 'fallback', matched: null };
}

function main() {
  const overture = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'overture_health.json'), 'utf8'));
  const foursquare = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'foursquare_health.json'), 'utf8'));

  const fsqUsed = new Set();
  const merged = [];
  let dupCount = 0;

  for (const ov of overture) {
    const ovNameNorm = normalizeForDedup(ov.name);
    let match = null;
    for (let i = 0; i < foursquare.length; i++) {
      if (fsqUsed.has(i)) continue;
      const fq = foursquare[i];
      if (normalizeForDedup(fq.name) !== ovNameNorm) continue;
      if (haversineMeters(ov.lat, ov.lng, fq.lat, fq.lng) < MERGE_DISTANCE_M) { match = { idx: i, fq }; break; }
    }
    const rec = {
      overture_id: ov.source_id,
      foursquare_id: match ? match.fq.source_id : null,
      name: ov.name,
      address: ov.address || (match ? match.fq.address : null),
      phone: ov.phone || (match ? match.fq.phone : null),
      website: ov.website || (match ? match.fq.website : null),
      lat: ov.lat, lng: ov.lng,
      city: ov.city,
      confidence: ov.confidence,
      probably_closed: !!(match && match.fq.date_closed),
      closed_signal_source: (match && match.fq.date_closed) ? 'foursquare_date_closed' : null,
      source_taxonomy_hint: OVERTURE_TAXONOMY_HINT[ov.taxonomy_primary] || (match ? fsqTaxonomyHint(match.fq.fsq_category_labels) : null),
    };
    if (match) { fsqUsed.add(match.idx); dupCount++; }
    merged.push(rec);
  }
  // Foursquare non fusionnées : fiches propres à cette source, ajoutées telles quelles.
  for (let i = 0; i < foursquare.length; i++) {
    if (fsqUsed.has(i)) continue;
    const fq = foursquare[i];
    merged.push({
      overture_id: null,
      foursquare_id: fq.source_id,
      name: fq.name,
      address: fq.address, phone: fq.phone, website: fq.website,
      lat: fq.lat, lng: fq.lng, city: fq.city,
      confidence: null,
      probably_closed: !!fq.date_closed,
      closed_signal_source: fq.date_closed ? 'foursquare_date_closed' : null,
      source_taxonomy_hint: fsqTaxonomyHint(fq.fsq_category_labels),
    });
  }

  // Exclusion par mots-clés du nom (décision BOSS, Phase 2 bis) — vérifiée AVANT toute
  // classification : une fiche exclue n'est jamais importée, quelle que soit sa catégorie santé
  // probable. Sorties dans un fichier séparé pour contrôle (jamais silencieuses).
  const kept = [], excluded = [];
  for (const rec of merged) {
    const ex = isExcludedByKeyword(rec.name);
    if (ex.excluded) excluded.push({ ...rec, exclusion_matched_keyword: ex.matchedKeyword });
    else kept.push(rec);
  }

  for (const rec of kept) {
    const c = classify(rec.name, rec.source_taxonomy_hint);
    rec.category_id = c.category;
    rec.classification_method = c.method;
    rec.classification_matched_keyword = c.matched;
  }

  fs.writeFileSync(path.join(OUT_DIR, 'merged.json'), JSON.stringify(kept, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'excluded_by_keyword.json'), JSON.stringify(excluded, null, 2));
  const byCategory = {};
  for (const r of kept) byCategory[r.category_id] = (byCategory[r.category_id] || 0) + 1;
  console.log('Fusion :', overture.length, 'Overture +', foursquare.length, 'Foursquare, doublons fusionnés :', dupCount);
  console.log('Total après fusion (avant exclusion mots-clés) :', merged.length);
  console.log('Exclues par mot-clé (non-établissements) :', excluded.length, '— détail : out/excluded_by_keyword.json');
  for (const r of excluded) console.log('  -', JSON.stringify(r.name), '(mot-clé:', r.exclusion_matched_keyword + ')');
  console.log('Total final importé :', kept.length);
  console.log('Marquées probablement fermées :', kept.filter(r => r.probably_closed).length);
  console.log('Par catégorie :', JSON.stringify(byCategory, null, 1));
  console.log('Méthode de classement :', JSON.stringify(kept.reduce((a, r) => { a[r.classification_method] = (a[r.classification_method] || 0) + 1; return a; }, {})));
}

if (require.main === module) main();
module.exports = { main, haversineMeters, normalizeForDedup, classify };
