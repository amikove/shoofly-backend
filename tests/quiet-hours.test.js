// Tests purs de la plage de silence (utils/quietHours.js) — aucune base requise.
// Heure de référence : Africa/Casablanca = UTC+1 en octobre (pas d'heure d'été, hors Ramadan).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { casaParts, isQuietHour, quietWindowEnd, deliveryPlan } = require('../src/utils/quietHours');

const at = (iso) => new Date(iso);

test('casaParts lit l\'heure murale de Casablanca, quel que soit le fuseau du process', () => {
  const p = casaParts(at('2026-10-06T21:30:00Z'));
  assert.deepEqual({ y: p.y, mo: p.mo, d: p.d, h: p.h, mi: p.mi }, { y: 2026, mo: 10, d: 6, h: 22, mi: 30 });
});

test('isQuietHour : plage par défaut 22 → 7 (passe minuit)', () => {
  assert.equal(isQuietHour(22, 22, 7), true);
  assert.equal(isQuietHour(0, 22, 7), true);
  assert.equal(isQuietHour(6, 22, 7), true);
  assert.equal(isQuietHour(7, 22, 7), false);
  assert.equal(isQuietHour(21, 22, 7), false);
});

test('isQuietHour : plage non par défaut 1 → 5 (dans la journée) et début = fin désactive', () => {
  assert.equal(isQuietHour(1, 1, 5), true);
  assert.equal(isQuietHour(4, 1, 5), true);
  assert.equal(isQuietHour(5, 1, 5), false);
  assert.equal(isQuietHour(0, 1, 5), false);
  assert.equal(isQuietHour(3, 3, 3), false);
});

test('quietWindowEnd : le soir (22 h 30 Casa) → fin le lendemain à 7 h Casa (06:00Z)', () => {
  const end = quietWindowEnd(at('2026-10-06T21:30:00Z'), 22, 7);
  assert.equal(end.toISOString(), '2026-10-07T06:00:00.000Z');
});

test('quietWindowEnd : la nuit (3 h Casa) → fin le même jour à 7 h Casa', () => {
  const end = quietWindowEnd(at('2026-10-07T02:00:00Z'), 22, 7);
  assert.equal(end.toISOString(), '2026-10-07T06:00:00.000Z');
});

test('quietWindowEnd : en journée (11 h Casa) → pas de plage, null', () => {
  assert.equal(quietWindowEnd(at('2026-10-07T10:00:00Z'), 22, 7), null);
});

test('quietWindowEnd : plage non par défaut 1 → 5 (23 h 30 UTC = 00 h 30 Casa, pas dans la plage)', () => {
  assert.equal(quietWindowEnd(at('2026-10-06T23:30:00Z'), 1, 5), null);
  const end = quietWindowEnd(at('2026-10-07T01:30:00Z'), 1, 5); // 02 h 30 Casa
  assert.equal(end.toISOString(), '2026-10-07T04:00:00.000Z'); // 05 h 00 Casa
});

test('deliveryPlan : hors plage → envoi immédiat (null)', () => {
  assert.equal(deliveryPlan(at('2026-10-07T10:00:00Z'), 22, 7, null), null);
});

test('deliveryPlan : dans la plage, mission sans créneau connu → report à la fin de plage', () => {
  const plan = deliveryPlan(at('2026-10-06T21:30:00Z'), 22, 7, null);
  assert.equal(plan.toISOString(), '2026-10-07T06:00:00.000Z');
});

test('deliveryPlan : exception — mission qui commence avant fin de plage + 3 h → envoi immédiat', () => {
  // fin de plage 06:00Z ; +3 h = 09:00Z. Mission à 08:30Z (9 h 30 Casa) → immédiat.
  assert.equal(deliveryPlan(at('2026-10-06T21:30:00Z'), 22, 7, '2026-10-07T08:30:00Z'), null);
});

test('deliveryPlan : mission après fin de plage + 3 h → toujours reportée', () => {
  // Mission à 10:00Z (11 h Casa) ≥ 09:00Z → report à 06:00Z.
  const plan = deliveryPlan(at('2026-10-06T21:30:00Z'), 22, 7, '2026-10-07T10:00:00Z');
  assert.equal(plan.toISOString(), '2026-10-07T06:00:00.000Z');
});

test('deliveryPlan : plage désactivée (début = fin) → jamais de report', () => {
  assert.equal(deliveryPlan(at('2026-10-06T21:30:00Z'), 22, 22, null), null);
});
