// Scénarios 17 (new_oeil_mission_threshold), 18 (reactivation_default_score), 20 (response_time).
const { db, api, setSetting, resetSetting, end } = require('./lib');
const accounts = require('./accounts.json');

async function step(label, r) {
  console.log(label, r.status, JSON.stringify(r.data));
  if (r.status >= 400) throw new Error(`${label} failed`);
  return r.data;
}

(async () => {
  const admin = accounts.admin;
  const client = accounts.client;
  const results = {};

  // ═══ Scénario 17 — new_oeil_mission_threshold ═══
  {
    const reg = await api('POST', '/auth/register', { email: `audit2_oeilNew_${Date.now()}@test.local`, password: 'Test1234!', first_name: 'AuditNew', last_name: 'Test', role: 'oeil', city: 'Casablanca' });
    const oeil = { token: reg.data.token, id: reg.data.user.id };
    await db(`UPDATE oeil_profiles SET is_verified=true, is_available=true, total_missions=5 WHERE user_id=$1`, [oeil.id]);

    const c = await step('S17 create', await api('POST', '/missions', {
      type: 'personnalisee', title: 'Audit S17 new_oeil badge', address: '1 rue I', city: 'Casablanca',
      scheduled_at: new Date(Date.now() + 30 * 3600 * 1000).toISOString(), price: 150,
    }, client.token));
    await step('S17 interest', await api('POST', `/missions/${c.mission.id}/interest`, {}, oeil.token));
    await step('S17 hire', await api('POST', `/missions/${c.mission.id}/hire/${oeil.id}`, {}, client.token));

    const beforeR = await api('GET', `/missions/${c.mission.id}`, undefined, client.token);
    const isNewBefore = beforeR.data.mission.is_new_oeil; // seuil défaut 10, total_missions=5 -> 5<10 -> true

    await setSetting('new_oeil_mission_threshold', '2', admin.token);
    const afterR = await api('GET', `/missions/${c.mission.id}`, undefined, client.token);
    const isNewAfter = afterR.data.mission.is_new_oeil; // seuil réduit 2, total_missions=5 -> 5<2 -> false
    await resetSetting('new_oeil_mission_threshold', admin.token);

    results.s17 = {
      total_missions: 5,
      isNewBefore_expected: true, isNewBefore_observed: isNewBefore,
      isNewAfter_expected: false, isNewAfter_observed: isNewAfter,
      ok: isNewBefore === true && isNewAfter === false,
    };
  }

  // ═══ Scénario 18 — reactivation_default_score ═══
  {
    const reg = await api('POST', '/auth/register', { email: `audit2_oeilSusp_${Date.now()}@test.local`, password: 'Test1234!', first_name: 'AuditSusp', last_name: 'Test', role: 'oeil', city: 'Casablanca' });
    const oeil = { token: reg.data.token, id: reg.data.user.id };
    await db(`UPDATE users SET is_suspended=true, suspended_at=NOW(), suspended_reason='audit test' WHERE id=$1`, [oeil.id]);

    await setSetting('reactivation_default_score', '60', admin.token);
    const reactivateRes = await step('S18 reactivate', await api('POST', `/reliability/admin/${oeil.id}/reactivate`, {}, admin.token));
    await resetSetting('reactivation_default_score', admin.token);

    const userRow = (await db('SELECT reliability_score, is_suspended FROM users WHERE id=$1', [oeil.id]))[0];
    results.s18 = {
      expected_score: 60,
      observed_score: userRow.reliability_score,
      is_suspended_after: userRow.is_suspended,
      ok: userRow.reliability_score === 60 && userRow.is_suspended === false,
    };
  }

  // ═══ Scénario 20 — response_time_min_turns (affecte le calcul affiché) ═══
  {
    const regO = await api('POST', '/auth/register', { email: `audit2_oeilRT_${Date.now()}@test.local`, password: 'Test1234!', first_name: 'AuditRT', last_name: 'Test', role: 'oeil', city: 'Casablanca' });
    const oeil = { token: regO.data.token, id: regO.data.user.id };
    await db(`UPDATE oeil_profiles SET is_verified=true, is_available=true WHERE user_id=$1`, [oeil.id]);

    const c = await step('S20 create', await api('POST', '/missions', {
      type: 'personnalisee', title: 'Audit S20 response time', address: '1 rue J', city: 'Casablanca',
      scheduled_at: new Date(Date.now() + 30 * 3600 * 1000).toISOString(), price: 150,
    }, client.token));
    await step('S20 interest', await api('POST', `/missions/${c.mission.id}/interest`, {}, oeil.token));
    await step('S20 hire', await api('POST', `/missions/${c.mission.id}/hire/${oeil.id}`, {}, client.token));

    // 2 échanges (2 tours in->out) seulement — en dessous du seuil défaut (3 tours minimum)
    await api('POST', `/missions/${c.mission.id}/messages`, { content: 'Message client 1' }, client.token);
    await api('POST', `/missions/${c.mission.id}/messages`, { content: 'Réponse oeil 1' }, oeil.token);
    await api('POST', `/missions/${c.mission.id}/messages`, { content: 'Message client 2' }, client.token);
    await api('POST', `/missions/${c.mission.id}/messages`, { content: 'Réponse oeil 2' }, oeil.token);

    const { computeAvgResponseMinutesBulk } = require('../src/utils/responseTime');
    const beforeResult = await computeAvgResponseMinutesBulk(await getRawDb(), [oeil.id]);
    const beforeVal = beforeResult[oeil.id]; // attendu null (2 tours < 3 min_turns par défaut)

    await setSetting('response_time_min_turns', '1', admin.token);
    const afterResult = await computeAvgResponseMinutesBulk(await getRawDb(), [oeil.id]);
    const afterVal = afterResult[oeil.id]; // attendu un nombre (2 tours >= 1 min_turns)
    await resetSetting('response_time_min_turns', admin.token);

    results.s20 = {
      beforeVal_expected: null, beforeVal_observed: beforeVal,
      afterVal_expected_type: 'number', afterVal_observed: afterVal,
      ok: beforeVal === null && typeof afterVal === 'number',
    };
  }

  console.log(JSON.stringify(results, null, 2));
  await end();
})();

async function getRawDb() {
  const { Pool } = require('pg');
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  if (!global.__pool) global.__pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return global.__pool;
}
