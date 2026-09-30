// Étape 5 (Phase 3) : export JSON des données PUBLIÉES pour le générateur SSG (shoofly-react).
// Décision BOSS Phase 3 (Étape 2) : "Données lues depuis un export JSON produit par le backend (pas
// de connexion DB depuis Vercel)". Ne PUBLIE jamais autre chose que ce dont le générateur a besoin
// pour produire du HTML statique — voir aussi la garde ODbL en tête de routes/directory.js (pas
// d'export brut de la base exposé publiquement ; ce fichier est un artefact de BUILD LOCAL, jamais
// servi tel quel par une route HTTP).
//
// Seules les fiches status='published' ET dont la catégorie a is_published=true sont exportées —
// ni les fiches en pending_review/removed, ni les catégories non publiées (autres_administrations).
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const OUT_DIR = process.argv[2] || path.join(__dirname, '..', '..', '..', '..', 'shoofly-react', 'directory-data');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows: categories } = await client.query(
    `SELECT id, domain, label_fr, label_ar, schema_org_type, sort_order FROM directory_categories WHERE is_published=true ORDER BY sort_order`
  );
  const publishedCategoryIds = new Set(categories.map((c) => c.id));

  const { rows: establishments } = await client.query(
    `SELECT e.id, e.slug, e.name, e.category_id, e.city, e.neighborhood_id, e.address, e.phone,
            e.website, e.lat, e.lng, e.confidence, e.probably_closed
     FROM directory_establishments e
     JOIN directory_categories c ON c.id = e.category_id
     WHERE e.status='published' AND c.is_published=true
     ORDER BY e.confidence DESC NULLS LAST, e.name`
  );

  const usedNeighborhoodIds = new Set(establishments.map((e) => e.neighborhood_id).filter(Boolean));
  const { rows: neighborhoodsRaw } = await client.query(
    `SELECT id, city, name_fr, name_ar FROM directory_neighborhoods WHERE id = ANY($1)`,
    [[...usedNeighborhoodIds]]
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'categories.json'), JSON.stringify(categories, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'neighborhoods.json'), JSON.stringify(neighborhoodsRaw, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'establishments.json'), JSON.stringify(establishments, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify({ exported_at: new Date().toISOString() }, null, 2));

  console.log('Export ->', OUT_DIR);
  console.log('Catégories publiées :', categories.length, '/', (await client.query('SELECT count(*)::int n FROM directory_categories')).rows[0].n);
  console.log('Établissements exportés (publiés) :', establishments.length);
  console.log('Quartiers utilisés :', neighborhoodsRaw.length);

  await client.end();
}

if (require.main === module) main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
module.exports = { main };
