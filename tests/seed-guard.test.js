// Garde du seed (src/db/seedGuard.js) — pure, sans base.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { seedGuardError } = require('../src/db/seedGuard');

const LOCAL = 'postgresql://u:p@localhost:5432/shoofly';
const OK_ENV = { NODE_ENV: 'development', SHOOFLY_ALLOW_DESTRUCTIVE: '1' };

test('production : refusé même avec le drapeau', () => {
  assert.match(seedGuardError({ ...OK_ENV, NODE_ENV: 'production' }, LOCAL), /production/);
});

test('sans SHOOFLY_ALLOW_DESTRUCTIVE=1 : refusé', () => {
  assert.match(seedGuardError({ NODE_ENV: 'development' }, LOCAL), /SHOOFLY_ALLOW_DESTRUCTIVE=1/);
  assert.match(seedGuardError({ NODE_ENV: 'development', SHOOFLY_ALLOW_DESTRUCTIVE: 'yes' }, LOCAL), /SHOOFLY_ALLOW_DESTRUCTIVE=1/);
});

test('base distante (Render) : refusé même avec le drapeau', () => {
  const remote = 'postgresql://u:p@dpg-abc.oregon-postgres.render.com:5432/shoofly';
  assert.match(seedGuardError(OK_ENV, remote), /n'est pas locale/);
});

test('DATABASE_URL absente ou illisible : refusé', () => {
  assert.match(seedGuardError(OK_ENV, undefined), /DATABASE_URL absente/);
  assert.match(seedGuardError(OK_ENV, 'pas une url'), /DATABASE_URL absente/);
});

test('développement + drapeau + base locale : autorisé (null)', () => {
  assert.equal(seedGuardError(OK_ENV, LOCAL), null);
  assert.equal(seedGuardError(OK_ENV, 'postgresql://u:p@127.0.0.1:5432/shoofly'), null);
});
