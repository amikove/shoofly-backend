// Administrations — étape 1 : lecture du fichier officiel MTNRA (data.gov.ma, licence ODbL,
// "Liste des coordonnées alphanumériques des administrations publiques", déc. 2021, backing data
// de maps.service-public.ma). Fichier téléchargé une fois manuellement (pas d'API stable connue
// côté MTNRA) — voir RAPPORT_PHASE2BIS.md pour la source exacte et la discussion de fraîcheur.
// Filtre RST, extrait les champs utiles, calcule un identifiant SYNTHÉTIQUE stable (le fichier ne
// fournit aucun id) : hash du nom + ville + coordonnées arrondies à ~11 m (4 décimales) — stable
// d'un run à l'autre tant que le fichier source ne change pas de contenu pour cette ligne.
// IMPORTANT (bug trouvé en testant, corrigé ici) : un hash sur nom+ville SEULS collapse à tort deux
// établissements RÉELLEMENT DISTINCTS qui partagent un nom générique fréquent dans la même ville
// (ex. "Dispensaire", "École Al Massira" — 132 collisions mesurées sur 2463 lignes RST) : la 2e
// fiche écrasait silencieusement la 1re au lieu d'être importée séparément. Les coordonnées GPS
// (présentes sur 99,9% des lignes) séparent presque toujours deux adresses différentes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { normalizeCore } = require('./keyword-rules');

const XLSX_PATH = path.join(__dirname, 'data', 'mtnra_administrations_2021.xlsx');
const OUT_FILE = path.join(__dirname, 'out', 'mtnra_admin.json');

function parseWkt(wkt) {
  if (!wkt) return null;
  const m = /POINT\(([\-0-9.]+)\s+([\-0-9.]+)\)/.exec(wkt);
  if (!m) return null;
  return { lng: Number(m[1]), lat: Number(m[2]) };
}

function mtnraId(nameFr, city, lat, lng) {
  const coords = (lat != null && lng != null) ? `${lat.toFixed(4)},${lng.toFixed(4)}` : 'no-coords';
  const key = normalizeCore(nameFr) + '|' + normalizeCore(city || '') + '|' + coords;
  return 'mtnra-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function assignCity(row) {
  const v = `${row['Ville ou Commune (fr)'] || ''} ${row['Commune (fr)'] || ''} ${row['Province (fr)'] || ''}`;
  if (/rabat/i.test(v)) return 'Rabat';
  if (/sal[ée]/i.test(v)) return 'Salé';
  if (/t[ée]mara|harhoura|skhirat/i.test(v)) return 'Témara';
  return null;
}

function main() {
  const wb = XLSX.readFile(XLSX_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
  console.log('Lignes totales (Maroc entier) :', rows.length);

  const records = [];
  for (const r of rows) {
    const city = assignCity(r);
    if (!city) continue;
    const point = parseWkt(r.WKT);
    const nameFr = r['Nom français'];
    if (!nameFr) continue;
    records.push({
      mtnra_id: mtnraId(nameFr, city, point ? point.lat : null, point ? point.lng : null),
      name: nameFr,
      name_ar: r['Nom arabe'] || null,
      address: r['Adresse (fr)'] || null,
      address_ar: r['Adresse (ar)'] || null,
      phone: r.Telephone || r['Autre telephone'] || null,
      website: r['Site web'] || null,
      quartier_fr: r['Quartier (fr)'] || null,
      quartier_ar: r['Quartier (ar)'] || null,
      city,
      lat: point ? point.lat : null,
      lng: point ? point.lng : null,
    });
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(records, null, 2));
  const byCity = {};
  for (const r of records) byCity[r.city] = (byCity[r.city] || 0) + 1;
  console.log('Lignes RST retenues :', records.length, JSON.stringify(byCity));
  console.log('Avec coordonnées GPS :', records.filter((r) => r.lat).length);
  console.log('Avec quartier fourni :', records.filter((r) => r.quartier_fr).length);
}

if (require.main === module) main();
module.exports = { main, mtnraId, parseWkt };
