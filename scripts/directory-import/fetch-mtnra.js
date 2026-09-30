// Administrations — étape 1 : téléchargement À L'EXÉCUTION du fichier officiel MTNRA depuis
// data.gov.ma (licence ODbL), dans un dossier TEMPORAIRE OS, jamais committé (Phase 5, 2026-09-30,
// décision BOSS). URL vérifiée manuellement sur le portail (pas devinée) : le dataset "Liste des
// coordonnées alphanumériques des administrations publiques" (page /dataset/liste-des-coordonnees-
// alphanumeriques-des-administrations-publiques) contient un fichier XLSX à un tout autre format
// (13971 lignes Maroc entier, colonnes nom_fr/adresse/telephone1/..., AUCUNE coordonnée GPS) — ce
// n'est PAS le bon jeu de données malgré le nom proche. Le fichier réellement utilisé par ce
// chantier depuis la Phase 2 vient du dataset "Coordonnées alphanumériques des administrations
// disponibles sur le portail maps.service-public.ma" (producteur MTNRA également) : structure
// vérifiée identique à l'octet près aux colonnes attendues ci-dessous (17500 lignes, colonne WKT
// avec coordonnées GPS, "Nom français"/"Ville ou Commune (fr)"/"Quartier (fr)" etc.).
// Filtre RST, extrait les champs utiles, calcule un identifiant SYNTHÉTIQUE stable (le fichier ne
// fournit aucun id) : hash du nom + ville + coordonnées arrondies à ~11 m (4 décimales) — stable
// d'un run à l'autre tant que le fichier source ne change pas de contenu pour cette ligne.
// IMPORTANT (bug trouvé en testant, corrigé ici) : un hash sur nom+ville SEULS collapse à tort deux
// établissements RÉELLEMENT DISTINCTS qui partagent un nom générique fréquent dans la même ville
// (ex. "Dispensaire", "École Al Massira" — 132 collisions mesurées sur 2463 lignes RST) : la 2e
// fiche écrasait silencieusement la 1re au lieu d'être importée séparément. Les coordonnées GPS
// (présentes sur 99,9% des lignes) séparent presque toujours deux adresses différentes.
//
// Échec (réseau, HTTP non-200, colonnes attendues absentes = format changé) : ÉCHEC EXPLICITE
// (throw), rien n'est écrit dans out/ — le domaine "administrations" est ignoré pour ce run par
// l'orchestrateur, aucune fiche existante n'est supprimée.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { normalizeCore } = require('./keyword-rules');

const USER_AGENT = 'ShooflyDirectoryBot/1.0 (+https://shoofly.ma; contact: contact@shoofly.ma)';
const MTNRA_URL = 'https://data.gov.ma/data/fr/dataset/ae610ab4-9300-41cd-876b-f66ff60cc05e/resource/6898670a-b11f-416a-8aa3-30692b2841a7/download/donnees-geoportail-open-data-2022.xlsx';
const REQUIRED_COLUMNS = ['Nom français', 'WKT', 'Ville ou Commune (fr)', 'Quartier (fr)', 'Adresse (fr)'];
const OUT_FILE = path.join(__dirname, 'out', 'mtnra_admin.json');

async function downloadXlsx() {
  const res = await fetch(MTNRA_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`MTNRA (data.gov.ma) : HTTP ${res.status} — téléchargement échoué`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shoofly-mtnra-')), 'mtnra.xlsx');
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

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

async function main() {
  console.log('Téléchargement MTNRA (data.gov.ma)...');
  const tmpPath = await downloadXlsx();
  let rows;
  try {
    const wb = XLSX.readFile(tmpPath);
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
  } finally {
    fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true }); // dossier temp jamais gardé, succès ou échec
  }
  if (rows.length === 0) throw new Error('MTNRA : fichier téléchargé vide — format probablement changé');
  const firstRow = rows[0];
  const missingCols = REQUIRED_COLUMNS.filter((c) => !(c in firstRow));
  if (missingCols.length > 0) {
    throw new Error(`MTNRA : colonnes attendues absentes (${missingCols.join(', ')}) — format du fichier source probablement changé, échec volontaire`);
  }
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

if (require.main === module) {
  main().catch((e) => { console.error('ERREUR MTNRA :', e.message); process.exit(1); });
}
module.exports = { main, mtnraId, parseWkt };
