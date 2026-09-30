// Administrations — étape 2 : reclassement (mots-clés, même moteur que la santé) + recoupement
// multi-source + fusion spéciale pour les banques (décision BOSS Phase 2 bis, 2026-09-30).
//
// Règle générale (9 catégories hors banque + "Autres administrations") : MTNRA est la source de
// base (nom AR + quartier FR/AR officiels utilisés tels quels, jamais une translittération -
// décision #2). Chaque fiche est recoupée par nom normalisé + distance < 100 m contre
// Overture/Foursquare/OSM : confirmée par au moins une autre source → confiance HAUTE (0.85) ;
// non confirmée → importée quand même, confiance de BASE MTNRA (0.6 — décision Phase 3 #2 : "source
// officielle", relevée depuis 0.35 en Phase 2 bis) — rien n'est écarté, seul le tri à l'affichage
// change, aucun seuil de publication (même principe que la décision #2 de l'étude initiale santé).
//
// Cas spécial banques (décision explicite) : fusion réelle MTNRA + OSM (209 mesurés en Phase 2) +
// Foursquare, dédoublonnée (nom normalisé + distance < 100 m) — pas seulement une confirmation de
// MTNRA. Confiance : ≥2 sources d'accord → haute (0.85) ; MTNRA seul → base MTNRA (0.6) ; OSM ou
// Foursquare seul (jamais vu côté MTNRA, source non-officielle) → confiance basse générique (0.4).
//
// Exclusion par mots-clés (tram/station/parking) appliquée ICI AUSSI (décision #1 : "santé et
// administrations") — une administration MTNRA au nom d'un arrêt de transport serait exclue de la
// même façon qu'en santé.

const fs = require('fs');
const path = require('path');
const { isExcludedByKeyword, normalizeCore } = require('./keyword-rules');
const { classifyAdminByName } = require('./keyword-rules-admin');

const OUT_DIR = path.join(__dirname, 'out');
const CORROBORATION_DISTANCE_M = 100;
const CONFIDENCE_HIGH = 0.85;
const CONFIDENCE_MTNRA_BASE = 0.6; // décision Phase 3 #2 : "source officielle"
const CONFIDENCE_OTHER_LOW = 0.4; // fiche non-MTNRA, source unique (OSM ou Foursquare seul)

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function normDedup(name) { return normalizeCore(name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

function findCorroboration(record, candidates) {
  const n = normDedup(record.name);
  for (const c of candidates) {
    if (!c.lat || !record.lat) continue;
    if (normDedup(c.name) !== n) continue;
    if (haversineMeters(record.lat, record.lng, c.lat, c.lng) < CORROBORATION_DISTANCE_M) return c;
  }
  return null;
}

function main() {
  const mtnra = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'mtnra_admin.json'), 'utf8'));
  const overture = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'overture_admin.json'), 'utf8'));
  const foursquare = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'foursquare_admin.json'), 'utf8'));
  const osm = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'osm_admin.json'), 'utf8'));
  const allOtherSources = [...overture, ...foursquare, ...osm];

  // 1) Exclusion + classification de toutes les fiches MTNRA.
  const excluded = [];
  const classified = [];
  for (const rec of mtnra) {
    const ex = isExcludedByKeyword(rec.name);
    if (ex.excluded) { excluded.push({ ...rec, exclusion_matched_keyword: ex.matchedKeyword }); continue; }
    const c = classifyAdminByName(rec.name);
    classified.push({ ...rec, category_id: c.category, classification_matched_keyword: c.matchedKeyword });
  }

  const banqueMtnra = classified.filter((r) => r.category_id === 'banque');
  const autresMtnra = classified.filter((r) => r.category_id !== 'banque');

  // 2) Catégories hors banque : MTNRA + confirmation (pas de fusion, pas d'ajout de fiches non-MTNRA).
  let corroborated = 0;
  const finalNonBank = autresMtnra.map((rec) => {
    const match = findCorroboration(rec, allOtherSources);
    if (match) corroborated++;
    return {
      mtnra_id: rec.mtnra_id, overture_id: null, foursquare_id: null, osm_id: null,
      primary_source: 'mtnra',
      name: rec.name, name_ar: rec.name_ar,
      address: rec.address, phone: rec.phone, website: rec.website,
      lat: rec.lat, lng: rec.lng, city: rec.city,
      quartier_fr: rec.quartier_fr, quartier_ar: rec.quartier_ar,
      category_id: rec.category_id,
      confidence: match ? CONFIDENCE_HIGH : CONFIDENCE_MTNRA_BASE,
      corroborated_by: match ? 'oui' : 'non',
    };
  });

  // 3) Banques : fusion réelle MTNRA + OSM + Foursquare, dédoublonnée.
  const osmBanks = osm.filter((r) => r.amenity === 'bank');
  const fsqBanks = foursquare.filter((r) => Array.isArray(r.fsq_category_labels) && r.fsq_category_labels.some((l) => /bank|financial/i.test(l)));
  const usedOsm = new Set(), usedFsq = new Set();
  const finalBanks = [];

  for (const rec of banqueMtnra) {
    let sources = 1;
    const osmMatch = osmBanks.findIndex((o, i) => !usedOsm.has(i) && normDedup(o.name) === normDedup(rec.name) && rec.lat && haversineMeters(rec.lat, rec.lng, o.lat, o.lng) < CORROBORATION_DISTANCE_M);
    if (osmMatch >= 0) { usedOsm.add(osmMatch); sources++; }
    const fsqMatch = fsqBanks.findIndex((f, i) => !usedFsq.has(i) && normDedup(f.name) === normDedup(rec.name) && rec.lat && haversineMeters(rec.lat, rec.lng, f.lat, f.lng) < CORROBORATION_DISTANCE_M);
    if (fsqMatch >= 0) { usedFsq.add(fsqMatch); sources++; }
    finalBanks.push({
      mtnra_id: rec.mtnra_id,
      overture_id: null,
      foursquare_id: fsqMatch >= 0 ? fsqBanks[fsqMatch].source_id : null,
      osm_id: osmMatch >= 0 ? osmBanks[osmMatch].source_id : null,
      primary_source: 'mtnra',
      name: rec.name, name_ar: rec.name_ar,
      address: rec.address, phone: rec.phone, website: rec.website,
      lat: rec.lat, lng: rec.lng, city: rec.city,
      quartier_fr: rec.quartier_fr, quartier_ar: rec.quartier_ar,
      category_id: 'banque', confidence: sources >= 2 ? CONFIDENCE_HIGH : CONFIDENCE_MTNRA_BASE,
      corroborated_by: sources >= 2 ? 'oui' : 'non',
    });
  }
  // Banques OSM-seules (jamais vues côté MTNRA ni Foursquare pour ce point) — exclusion mots-clés appliquée.
  for (let i = 0; i < osmBanks.length; i++) {
    if (usedOsm.has(i)) continue;
    const o = osmBanks[i];
    if (isExcludedByKeyword(o.name).excluded) continue;
    const fsqMatch = fsqBanks.findIndex((f, j) => !usedFsq.has(j) && normDedup(f.name) === normDedup(o.name) && haversineMeters(o.lat, o.lng, f.lat, f.lng) < CORROBORATION_DISTANCE_M);
    if (fsqMatch >= 0) usedFsq.add(fsqMatch);
    finalBanks.push({
      mtnra_id: null, overture_id: null,
      foursquare_id: fsqMatch >= 0 ? fsqBanks[fsqMatch].source_id : null,
      osm_id: o.source_id, primary_source: 'osm_overpass',
      name: o.name, name_ar: null, address: null, phone: o.phone || null, website: null,
      lat: o.lat, lng: o.lng, city: null, quartier_fr: null, quartier_ar: null,
      category_id: 'banque', confidence: fsqMatch >= 0 ? CONFIDENCE_HIGH : CONFIDENCE_OTHER_LOW,
      corroborated_by: fsqMatch >= 0 ? 'oui' : 'non',
    });
  }
  // Banques Foursquare-seules restantes.
  for (let i = 0; i < fsqBanks.length; i++) {
    if (usedFsq.has(i)) continue;
    const f = fsqBanks[i];
    if (isExcludedByKeyword(f.name).excluded) continue;
    finalBanks.push({
      mtnra_id: null, overture_id: null, foursquare_id: f.source_id, osm_id: null,
      primary_source: 'foursquare',
      name: f.name, name_ar: null, address: f.address || null, phone: f.phone || null, website: f.website || null,
      lat: f.lat, lng: f.lng, city: f.city || null, quartier_fr: null, quartier_ar: null,
      category_id: 'banque', confidence: CONFIDENCE_OTHER_LOW, corroborated_by: 'non',
    });
  }
  // Les fiches sans ville assignée (banques OSM/FSQ hors polygones RST) sont écartées ici — pas
  // une exclusion mot-clé, juste hors zone d'étude.
  const finalBanksInZone = finalBanks.filter((r) => r.city);

  const merged = [...finalNonBank, ...finalBanksInZone];
  fs.writeFileSync(path.join(OUT_DIR, 'merged_admin.json'), JSON.stringify(merged, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'excluded_admin_by_keyword.json'), JSON.stringify(excluded, null, 2));

  const byCategory = {};
  for (const r of merged) byCategory[r.category_id] = (byCategory[r.category_id] || 0) + 1;
  console.log('MTNRA RST :', mtnra.length, '| exclues par mot-clé :', excluded.length);
  for (const r of excluded) console.log('  -', JSON.stringify(r.name), '(mot-clé:', r.exclusion_matched_keyword + ')');
  console.log('Hors-banque : ', finalNonBank.length, '| confirmées par une autre source :', corroborated, `(${((100 * corroborated) / finalNonBank.length).toFixed(1)}%)`);
  console.log('Banques (fusion MTNRA+OSM+Foursquare) :', finalBanksInZone.length,
    '| dont haute confiance (≥2 sources) :', finalBanksInZone.filter((r) => r.confidence === CONFIDENCE_HIGH).length);
  console.log('Total administrations importées :', merged.length);
  console.log('Par catégorie :', JSON.stringify(byCategory, null, 1));
}

if (require.main === module) main();
module.exports = { main, haversineMeters, normDedup };
