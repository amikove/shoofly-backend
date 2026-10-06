// Règle « administrations » (utils/administrationHours.js). Heure de Casablanca = UTC+1 en octobre.
// Les tests purs n'ont pas besoin de base ; le test d'intégration (prepareMissionInsert) lit les
// réglages en base et est sauté sans DATABASE_URL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  isAdministrationSubcategory, administrationSlotViolation, checkAdministrationSlot,
} = require('../src/utils/administrationHours');

// Lundi 5 octobre 2026 (vérifié par le test ci-dessous). Casablanca = UTC + 1 h : 16 h 59 Casa = 15 h 59 UTC.
const ADMIN = 'Administrations — CNSS';
const CENTRE = 'Centres de santé — Hôpital & clinique';
const casa = (day, hh, mm) => new Date(Date.UTC(2026, 9, day, hh - 1, mm)).toISOString(); // octobre, UTC+1

test('base : le 5 octobre 2026 est un lundi', () => {
  assert.equal(new Date(Date.UTC(2026, 9, 5)).getUTCDay(), 1);
});

test('reconnaît une sous-catégorie administration, pas les autres', () => {
  assert.equal(isAdministrationSubcategory(ADMIN), true);
  assert.equal(isAdministrationSubcategory(CENTRE), false);
  assert.equal(isAdministrationSubcategory(null), false);
});

test('créneau 16 h 59 un jour de semaine : accepté', () => {
  assert.equal(administrationSlotViolation(casa(5, 16, 59), 17), null);
});

test('créneau 17 h 00 un jour de semaine : refusé (après_fermeture)', () => {
  assert.equal(administrationSlotViolation(casa(5, 17, 0), 17), 'after_closing');
});

test('samedi refusé (10 h du matin)', () => {
  assert.equal(administrationSlotViolation(casa(10, 10, 0), 17), 'weekend'); // lundi 5 + 5 jours = samedi 10
});

test('dimanche refusé', () => {
  assert.equal(administrationSlotViolation(casa(11, 9, 0), 17), 'weekend');
});

test('autre catégorie à 20 h : acceptée (la règle ne s\'applique pas)', async () => {
  const res = await checkAdministrationSlot(null, { subcategory: CENTRE, scheduledAt: casa(5, 20, 0) });
  assert.equal(res, null);
});

test('réglage non par défaut (fermeture à 15 h) : 14 h 59 accepté, 15 h 00 refusé', () => {
  assert.equal(administrationSlotViolation(casa(5, 14, 59), 15), null);
  assert.equal(administrationSlotViolation(casa(5, 15, 0), 15), 'after_closing');
});

test('date invalide : pas de refus de cette règle (rejetée ailleurs)', async () => {
  assert.equal(await checkAdministrationSlot(null, { subcategory: ADMIN, scheduledAt: 'pas une date' }), null);
});

// ── Intégration : le vrai prepareMissionInsert refuse avant toute autre validation ──────────────
const URL_DB = (() => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const f = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(f)) return null;
  const m = fs.readFileSync(f, 'utf8').match(/^DATABASE_URL=(.*)$/m);
  return m ? m[1].trim() : null;
})();
const SKIP = URL_DB ? false : 'DATABASE_URL absente';
let db;
let savedClosing;
before(async () => {
  if (SKIP) return;
  const { Pool } = require('pg');
  db = new Pool({ connectionString: URL_DB, max: 2 });
  const { rows } = await db.query(`SELECT value FROM settings WHERE key='administration_closing_hour'`);
  savedClosing = rows.length ? rows[0].value : null;
  await db.query(`INSERT INTO settings (key,value) VALUES ('administration_closing_hour','17')
                  ON CONFLICT (key) DO UPDATE SET value='17'`);
});
after(async () => {
  if (SKIP || !db) return;
  if (savedClosing === null) await db.query(`DELETE FROM settings WHERE key='administration_closing_hour'`);
  else await db.query(`UPDATE settings SET value=$1 WHERE key='administration_closing_hour'`, [savedClosing]);
  await db.end();
});

test('création : prepareMissionInsert refuse une administration à 17 h (code ADMINISTRATION_HOURS)', { skip: SKIP }, async () => {
  const { prepareMissionInsert } = require('../src/routes/missions');
  const out = await prepareMissionInsert(db, 'nobody', {
    type: 'file_attente', subcategory: ADMIN, scheduled_at: casa(5, 17, 0),
  });
  assert.equal(out.code, 'ADMINISTRATION_HOURS');
  assert.match(out.error, /fermées après 17 h et le week-end\. Choisissez un créneau plus tôt\./);
});

test('création : même administration le samedi refusée', { skip: SKIP }, async () => {
  const { prepareMissionInsert } = require('../src/routes/missions');
  const out = await prepareMissionInsert(db, 'nobody', {
    type: 'file_attente', subcategory: ADMIN, scheduled_at: casa(10, 10, 0),
  });
  assert.equal(out.code, 'ADMINISTRATION_HOURS');
});

test('création : administration à 16 h 59 n\'est pas refusée par cette règle', { skip: SKIP }, async () => {
  const { prepareMissionInsert } = require('../src/routes/missions');
  const out = await prepareMissionInsert(db, 'nobody', {
    type: 'file_attente', subcategory: ADMIN, scheduled_at: casa(5, 16, 59),
  });
  assert.notEqual(out.code, 'ADMINISTRATION_HOURS');
});

test('création : autre catégorie à 20 h n\'est pas refusée par cette règle', { skip: SKIP }, async () => {
  const { prepareMissionInsert } = require('../src/routes/missions');
  const out = await prepareMissionInsert(db, 'nobody', {
    type: 'file_attente', subcategory: CENTRE, scheduled_at: casa(5, 20, 0),
  });
  assert.notEqual(out.code, 'ADMINISTRATION_HOURS');
});

test('réglage en base : fermeture à 15 h appliquée immédiatement', { skip: SKIP }, async () => {
  await db.query(`UPDATE settings SET value='15' WHERE key='administration_closing_hour'`);
  const { invalidateSettingsCache } = require('../src/utils/settings');
  invalidateSettingsCache();
  const out = await checkAdministrationSlot(db, { subcategory: ADMIN, scheduledAt: casa(5, 15, 0) });
  assert.equal(out.code, 'ADMINISTRATION_HOURS');
  assert.equal(out.closingHour, 15);
  assert.equal(await checkAdministrationSlot(db, { subcategory: ADMIN, scheduledAt: casa(5, 14, 59) }), null);
  await db.query(`UPDATE settings SET value='17' WHERE key='administration_closing_hour'`);
  invalidateSettingsCache();
});

// ── Exclusion Adoul / Notaires (décision BOSS) ─────────────────────────────────────────────────
test('Adoul / Notaires exclue : même à 17 h, la règle ne s\'applique pas', async () => {
  const ADOUL = 'Administrations — Adoul / Notaires';
  assert.equal(isAdministrationSubcategory(ADOUL), false);
  assert.equal(await checkAdministrationSlot(null, { subcategory: ADOUL, scheduledAt: casa(5, 17, 0) }), null);
});

// ── Fuseau IANA : Casablanca à UTC+0 pendant le Ramadan (pas de décalage fixe) ─────────────────
const { casaWallToInstant, casaOffsetHours } = require('./helpers/casa');
test('Ramadan (Casablanca à UTC+0) : 16 h 59 accepté, 17 h 00 refusé, instants en UTC+0', () => {
  // 15 février 2027 : lundi, Ramadan. Décalage réel mesuré par Intl = 0.
  assert.equal(casaOffsetHours(new Date('2027-02-15T12:00:00Z')), 0);
  const at1659 = casaWallToInstant(2027, 2, 15, 16, 59);
  const at1700 = casaWallToInstant(2027, 2, 15, 17, 0);
  assert.equal(at1659.toISOString(), '2027-02-15T16:59:00.000Z'); // un décalage fixe de +1 donnerait 15:59Z
  assert.equal(at1700.toISOString(), '2027-02-15T17:00:00.000Z');
  assert.equal(administrationSlotViolation(at1659, 17), null);
  assert.equal(administrationSlotViolation(at1700, 17), 'after_closing');
});

test('Hors Ramadan (UTC+1) : 16 h 59 accepté, 17 h 00 refusé', () => {
  assert.equal(casaOffsetHours(new Date('2026-10-06T12:00:00Z')), 1);
  assert.equal(administrationSlotViolation(casaWallToInstant(2026, 10, 5, 16, 59), 17), null);
  assert.equal(administrationSlotViolation(casaWallToInstant(2026, 10, 5, 17, 0), 17), 'after_closing');
});
