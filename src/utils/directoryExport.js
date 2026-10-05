// Chantier SEO annuaire — Phase 4, décision #2. Requête partagée entre la route d'export protégée
// (routes/directory.js, GET /api/directory/export) et le script d'export local
// (scripts/directory-import/export-json.js, pratique pour tester sans backend qui tourne) — un
// seul endroit définit "quelles fiches sont publiques", jamais deux versions divergentes.
async function getPublishedDirectoryData(db) {
  const { rows: categories } = await db.query(
    `SELECT id, domain, label_fr, label_ar, schema_org_type, sort_order FROM directory_categories WHERE is_published=true ORDER BY sort_order`
  );

  const { rows: establishments } = await db.query(
    `SELECT e.id, e.slug, e.name, e.category_id, e.city, e.neighborhood_id, e.address, e.phone,
            e.website, e.lat, e.lng, e.confidence, e.probably_closed, e.primary_source
     FROM directory_establishments e
     JOIN directory_categories c ON c.id = e.category_id
     WHERE e.status='published' AND c.is_published=true
     ORDER BY e.confidence DESC NULLS LAST, e.name`
  );

  // Fiches retirées (signalement admin, status='removed') ou non publiées (pending_review, catégorie
  // dépubliée) : le générateur s'en sert pour rediriger les anciennes URLs. UNIQUEMENT slug, ville et
  // catégorie — aucune autre donnée d'établissement ne sort par cette liste.
  const { rows: removed } = await db.query(
    `SELECT e.slug, e.city, e.category_id
     FROM directory_establishments e
     LEFT JOIN directory_categories c ON c.id = e.category_id
     WHERE e.status <> 'published' OR c.is_published IS NOT TRUE
     ORDER BY e.city, e.slug`
  );

  const usedNeighborhoodIds = [...new Set(establishments.map((e) => e.neighborhood_id).filter(Boolean))];
  const { rows: neighborhoods } = usedNeighborhoodIds.length
    ? await db.query(`SELECT id, city, name_fr, name_ar FROM directory_neighborhoods WHERE id = ANY($1)`, [usedNeighborhoodIds])
    : { rows: [] };

  return { categories, establishments, neighborhoods, removed, meta: { exported_at: new Date().toISOString() } };
}

module.exports = { getPublishedDirectoryData };
