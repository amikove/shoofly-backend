// Limites administratives des 3 villes RST — récupérées À L'EXÉCUTION depuis Nominatim (OSM),
// jamais committées (Phase 5, 2026-09-30, décision BOSS : data/ est gitignored, régénéré à chaque
// run). Utilisées par assign-neighborhoods.js et les scripts *.child.js DuckDB (ST_Read) pour
// classer les points OSM et les établissements par ville.
//
// Un seul appel à l'endpoint /lookup avec les 3 identifiants de RELATION OSM exacts (pas une
// recherche floue par nom de ville, qui pourrait retourner une entité différente — un quartier, un
// homonyme, etc.) : respecte très largement la politique d'usage Nominatim (max 1 req/s ; ici 1
// seule requête au total pour les 3 villes). Identifiants relevés une fois sur les fichiers
// data/boundary_*.geojson déjà utilisés par ce chantier depuis la Phase 2 (leurs propriétés
// conservaient le résultat Nominatim d'origine — osm_type=relation, osm_id — donc PAS devinés) :
//   Rabat  = relation OSM 2799215
//   Salé   = relation OSM 2801066
//   Témara = relation OSM 2498868 (englobe Skhirate-Témara, déjà le choix retenu par ce chantier)
//
// User-Agent identifiant Shoofly + URL de contact (politique Nominatim : obligatoire).
//
// Échec (réseau, ID introuvable dans la réponse, géométrie absente/invalide, format de réponse
// changé) : ÉCHEC EXPLICITE (throw), AUCUN fichier n'est écrit tant que les 3 limites n'ont pas été
// validées ensemble — jamais de data/boundary_*.geojson partiel ou à moitié à jour.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USER_AGENT = 'ShooflyDirectoryBot/1.0 (+https://shoofly.ma; contact: contact@shoofly.ma)';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/lookup?osm_ids=R2799215,R2801066,R2498868&format=jsonv2&polygon_geojson=1';

const CITIES = {
  2799215: { file: 'boundary_rabat.geojson', name: 'Rabat' },
  2801066: { file: 'boundary_sale.geojson', name: 'Salé' },
  2498868: { file: 'boundary_temara.geojson', name: 'Témara' },
};

async function main() {
  const res = await fetch(NOMINATIM_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Nominatim : HTTP ${res.status} — limites de villes indisponibles`);
  const results = await res.json();
  if (!Array.isArray(results)) throw new Error('Nominatim : réponse inattendue (pas un tableau) — format probablement changé');

  const toWrite = {};
  for (const r of results) {
    const meta = CITIES[r.osm_id];
    if (!meta) continue;
    if (!r.geojson || !['Polygon', 'MultiPolygon'].includes(r.geojson.type)) {
      throw new Error(`Nominatim : géométrie manquante ou invalide pour ${meta.name} (osm_id ${r.osm_id}) — format probablement changé`);
    }
    toWrite[r.osm_id] = {
      file: meta.file,
      name: meta.name,
      content: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { osm_id: r.osm_id, osm_type: r.osm_type, name: r.name, display_name: r.display_name },
          geometry: r.geojson,
        }],
      },
    };
  }

  const missing = Object.entries(CITIES).filter(([id]) => !toWrite[id]);
  if (missing.length > 0) {
    throw new Error(`Nominatim : limite(s) manquante(s) dans la réponse : ${missing.map(([, m]) => m.name).join(', ')} — échec volontaire, aucun fichier écrit`);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const { file, name, content } of Object.values(toWrite)) {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(content));
    console.log(`  -> ${name} : ${content.features[0].geometry.type}, écrit dans data/${file}`);
  }
  console.log('3/3 limites de villes récupérées depuis Nominatim.');
}

if (require.main === module) {
  main().catch((e) => { console.error('ERREUR limites de villes (Nominatim) :', e.message); process.exit(1); });
}
module.exports = { main };
