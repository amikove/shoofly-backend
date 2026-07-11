const router = require('express').Router();
const { getDb } = require('../db/schema');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

// ── POST /promo/validate — vérifier un code ───────────────
router.post('/validate', authenticate, asyncHandler(async (req, res) => {
  const db = getDb();
  const { code, price } = req.body;

  if (!code || !price) return res.status(400).json({ error: 'Code et prix requis' });

  const { rows: [promo] } = await db.query(
    `SELECT * FROM promo_codes WHERE UPPER(code)=UPPER($1) AND is_active=true`, [code]
  );

  if (!promo) return res.status(404).json({ error: 'Code promo invalide' });
  if (promo.expires_at && new Date(promo.expires_at) < new Date())
    return res.status(400).json({ error: 'Code promo expiré' });
  if (promo.max_uses && promo.used_count >= promo.max_uses)
    return res.status(400).json({ error: 'Code promo épuisé' });

  // Vérifier utilisation par cet utilisateur
  const { rows: [usage] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM promo_uses WHERE promo_id=$1 AND user_id=$2`,
    [promo.id, req.user.id]
  );
  if (usage.n >= promo.max_uses_per_user)
    return res.status(400).json({ error: 'Vous avez déjà utilisé ce code' });

  // Calculer la réduction
  const originalPrice = parseFloat(price);
  let discount = 0;
  if (promo.type === 'percent') discount = originalPrice * (parseFloat(promo.value) / 100);
  if (promo.type === 'fixed')   discount = Math.min(parseFloat(promo.value), originalPrice);
  if (promo.type === 'free')    discount = originalPrice;

  discount = Math.round(discount * 100) / 100;
  const finalPrice = Math.max(0, originalPrice - discount);

  res.json({
    valid: true,
    promo_id: promo.id,
    code: promo.code,
    type: promo.type,
    value: promo.value,
    discount,
    original_price: originalPrice,
    final_price: finalPrice,
    platform_amount: promo.platform_amount || null,
  });
}));

// ── GET /promo/admin — lister tous les codes ──────────────
router.get('/admin', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT p.*, u.first_name||' '||u.last_name AS created_by_name
     FROM promo_codes p
     LEFT JOIN users u ON u.id=p.created_by
     ORDER BY p.created_at DESC`
  );
  res.json({ promos: rows });
}));

// ── POST /promo/admin — créer un code ─────────────────────
router.post('/admin', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { code, type, value, max_uses, max_uses_per_user, expires_at, platform_amount } = req.body;

  if (!code || !type || value === undefined)
    return res.status(400).json({ error: 'Code, type et valeur requis' });
  if (!['percent','fixed','free'].includes(type))
    return res.status(400).json({ error: 'Type invalide' });
  if (type === 'percent' && (value < 1 || value > 100))
      return res.status(400).json({ error: 'Pourcentage entre 1 et 100' });

    if (expires_at && new Date(expires_at) < new Date())
      return res.status(400).json({ error: 'La date d\'expiration doit être dans le futur' });

    const { rows: [existing] } = await db.query(
      `SELECT id FROM promo_codes WHERE UPPER(code)=UPPER($1)`, [code]
    );
    if (existing) return res.status(409).json({ error: `Le code "${code.toUpperCase()}" existe déjà` });

    const { rows: [promo] } = await db.query(
      `INSERT INTO promo_codes (code, type, value, max_uses, max_uses_per_user, expires_at, platform_amount, created_by)
       VALUES (UPPER($1), $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [code, type, value, max_uses || null, max_uses_per_user || 1, expires_at || null, platform_amount || null, req.user.id]
    );
    res.status(201).json({ promo });
}));

// ── PUT /promo/admin/:id/toggle — activer/désactiver ─────
router.put('/admin/:id/toggle', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  const { rows: [promo] } = await db.query(
    `UPDATE promo_codes SET is_active=NOT is_active WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (!promo) return res.status(404).json({ error: 'Code introuvable' });
  res.json({ promo });
}));

// ── DELETE /promo/admin/:id ───────────────────────────────
router.delete('/admin/:id', authenticate, requireRole('admin'), asyncHandler(async (req, res) => {
  const db = getDb();
  await db.query(`DELETE FROM promo_codes WHERE id=$1`, [req.params.id]);
  res.json({ message: 'Code supprimé' });
}));

module.exports = router;