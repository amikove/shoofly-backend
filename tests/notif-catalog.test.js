// Contrôle exécutable des traductions notif.* (audit notifications, décision BOSS point 4) :
//  1. toute clé passée à notify()/notifyDifferable() existe dans le catalogue backend FR ET AR ;
//  2. FR et AR ont exactement les mêmes clés (backend) ;
//  3. si le dépôt frontend est présent : mêmes textes backend/frontend pour chaque clé commune,
//     et chaque clé utilisée existe aussi côté frontend (in-app).
// Sans dépôt frontend, le point 3 est sauté et le signale (pas d'échec : Render ne l'a pas).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const I18N = path.join(SRC, 'i18n');
const FRONT = path.join(__dirname, '..', '..', '..', 'shoofly-react', 'src', 'i18n', 'locales');

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

// Clés littérales passées à notify()/notifyDifferable() (arguments lus jusqu'à la parenthèse
// fermante ; les commentaires sont ignorés).
function notifyLiteralKeys() {
  const keys = new Set();
  const BS = String.fromCharCode(92);
  for (const file of walk(SRC)) {
    if (file.endsWith(path.join('utils', 'notify.js'))) continue;
    const src = fs.readFileSync(file, 'utf8');
    const re = /(?<![\w.])(notify|notifyDifferable)\(/g;
    let m;
    while ((m = re.exec(src))) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const lineText = src.slice(lineStart, m.index).trim();
      if (lineText.startsWith('//') || lineText.startsWith('*') || /function (notify|notifyDifferable)/.test(lineText)) continue;
      let depth = 0, i = m.index + m[1].length, inStr = null;
      const start = i;
      for (; i < src.length; i++) {
        const c = src[i];
        if (inStr) { if (c === BS) { i++; continue; } if (c === inStr) inStr = null; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === '(') depth++;
        if (c === ')') { depth--; if (depth === 0) break; }
      }
      const arg = src.slice(start, i);
      for (const k of arg.matchAll(/'([A-Za-z][A-Za-z0-9]*(?:Title|Body)[A-Za-z0-9]*)'/g)) keys.add(k[1]);
    }
  }
  return keys;
}

const BE_FR = JSON.parse(fs.readFileSync(path.join(I18N, 'notif.fr.json'), 'utf8'));
const BE_AR = JSON.parse(fs.readFileSync(path.join(I18N, 'notif.ar.json'), 'utf8'));
const USED = notifyLiteralKeys();

test('des clés notify() sont extraites du code (contrôle de l\'extracteur)', () => {
  assert.ok(USED.size > 100, `trop peu de clés extraites : ${USED.size}`);
  assert.ok(USED.has('staleMissionAdminTitle'));
  assert.ok(USED.has('missionStillUnfilledOeilTitle'));
});

test('chaque clé notify() existe dans le catalogue backend FR', () => {
  const missing = [...USED].filter((k) => BE_FR[k] === undefined);
  assert.deepEqual(missing, [], 'clés absentes du catalogue backend FR (push en repli FR)');
});

test('chaque clé notify() existe dans le catalogue backend AR', () => {
  const missing = [...USED].filter((k) => BE_AR[k] === undefined);
  assert.deepEqual(missing, [], 'clés absentes du catalogue backend AR (push en repli FR pour les AR)');
});

test('FR et AR ont exactement les mêmes clés (backend)', () => {
  assert.deepEqual(Object.keys(BE_FR).sort(), Object.keys(BE_AR).sort());
});

test('variables de placeholder bien formées dans les catalogues backend', () => {
  for (const [k, v] of Object.entries(BE_FR)) {
    const vars = [...v.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    assert.ok(vars.every((x) => /^[A-Za-z]+$/.test(x)), `${k} : variable mal formée`);
  }
});

// Textes dont le délai était écrit en dur : rendus avec des réglages NON par défaut, ils doivent
// suivre la valeur et ne plus contenir le délai d'origine (12 h, 24 h, 72 h, 45 min, 2 h, ~2 heures).
const DURATION_TEXTS = [
  ['staleMissionAdminBody', { missionTitle: 'M', hours: 7, count: 2 }, ['7 h', '2 candidature(s)'], ['12']],
  ['staleMissionAdminTitle', { hours: 7 }, ['7 h'], ['12']],
  ['staleMissionClientBody', { missionTitle: 'M', hours: 7 }, ['7 h'], ['12']],
  ['missionCompletedClientBody', { missionTitle: 'M', hours: 9 }, ['9 h'], ['12h', '12 h']],
  ['missionCancelledNoRefundBody', { hours: 3 }, ['3 h'], ['2h', '2 h']],
  ['activityPhotoRequestBody', { missionTitle: 'M', minutes: 33 }, ['33 minutes'], ['45 minutes']],
  ['ticketAutoResolvedBody', { hours: 48 }, ['48 h'], ['72']],
  ['missionToVerifyAdminBody', { missionTitle: 'M', oeilName: 'A B', hours: 30 }, ['30 h'], ['24h', '24 h']],
  ['presenceConfirmationRequestSamedayBody', { missionTitle: 'M', minutes: 90, deadlineTime: '14:00' }, ['90 minutes'], ['2 heures']],
  ['presenceConfirmationRequestJ1Body', { missionTitle: 'M', time: '14:30', deadlineTime: '20:00' }, ['avant 20:00'], ['ce soir']],
  ['pendingExpiredAdminBody', { missionTitle: 'M', hours: 36 }, ['36 h'], ['délai de grâce']],
  ['pendingExpiredCancelledClientRefundBody', { missionTitle: 'M', hours: 36, refund: 150 }, ['36h', '150 MAD'], []],
];
function render(tpl, params) {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : `{{${k}}}`));
}
for (const [key, params, mustHave, mustNotHave] of DURATION_TEXTS) {
  test(`texte « ${key} » suit le réglage`, () => {
    // FR : libellés et délais en dur vérifiés. AR : placeholders résolus et valeurs du réglage présentes.
    const fr = render(BE_FR[key], params);
    for (const s of mustHave) assert.ok(fr.includes(s), `${key} : « ${s} » absent de « ${fr} »`);
    for (const s of mustNotHave) assert.ok(!fr.includes(s), `${key} : délai en dur « ${s} » encore présent`);
    assert.ok(!/\{\{/.test(fr), `${key} : placeholder FR non résolu`);
    const ar = render(BE_AR[key], params);
    assert.ok(!/\{\{/.test(ar), `${key} : placeholder AR non résolu`);
    for (const [name, value] of Object.entries(params)) {
      if (typeof value === 'number') assert.ok(ar.includes(String(value)), `${key} : ${name}=${value} absent du texte AR`);
    }
  });
}

const hasFront = fs.existsSync(path.join(FRONT, 'fr.json'));
test('frontend : mêmes textes que le backend pour chaque clé commune, et clés utilisées présentes',
  { skip: hasFront ? false : 'dépôt frontend absent — contrôle de parité sauté' }, () => {
    for (const lang of ['fr', 'ar']) {
      const fe = JSON.parse(fs.readFileSync(path.join(FRONT, `${lang}.json`), 'utf8')).notif || {};
      const be = lang === 'fr' ? BE_FR : BE_AR;
      const drift = Object.keys(be).filter((k) => fe[k] !== undefined && fe[k] !== be[k]);
      assert.deepEqual(drift, [], `${lang} : textes différents backend/frontend`);
      const missingFe = [...USED].filter((k) => fe[k] === undefined);
      assert.deepEqual(missingFe, [], `${lang} : clés utilisées absentes du frontend (in-app)`);
    }
  });
