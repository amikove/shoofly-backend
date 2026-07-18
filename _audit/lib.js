require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BASE = 'http://127.0.0.1:3001/api';

const DEFAULTS = {
  transfer_grace_minutes_queue: '45',
  transfer_grace_minutes_other: '60',
  candidate_window_minutes_fast: '10',
  candidate_window_minutes_choose_queue: '5',
  candidate_window_minutes_choose_other: '10',
  mission_edit_approval_minutes: '120',
  mission_edit_approval_minutes_urgent: '30',
  mission_edit_urgent_threshold_hours: '4',
  client_validation_hours: '12',
  schedule_conflict_window_hours: '4',
  transfer_cooldown_hours: '4',
  abandon_during_mission_cooldown_hours: '48',
  stale_mission_hours: '12',
  stale_mission_min_lead_hours: '4',
  mission_overdue_verification_hours: '24',
  late_start_alert_window_minutes: '30',
  late_start_auto_transfer_minutes: '60',
  reminder_before_mission_minutes_early: '120',
  reminder_before_mission_minutes_late: '30',
  refund_partial_threshold_hours: '2',
  refund_partial_rate: '0.5',
  new_oeil_mission_threshold: '10',
  reactivation_default_score: '70',
  ticket_auto_resolve_hours: '72',
  response_time_max_valid_minutes: '1440',
  response_time_min_turns: '3',
  dashboard_stuck_pending_hours: '24',
  dashboard_low_reliability_threshold: '70',
};

async function db(sql, params) {
  const res = await pool.query(sql, params);
  return res.rows;
}

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

async function setSetting(key, value, adminToken) {
  const r = await api('PUT', '/users/admin/settings', { [key]: value }, adminToken);
  if (r.status !== 200) throw new Error(`setSetting(${key}) failed: ${JSON.stringify(r)}`);
  return r;
}

async function resetSetting(key, adminToken) {
  return setSetting(key, DEFAULTS[key], adminToken);
}

async function resetAllSettings(adminToken) {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    await setSetting(k, v, adminToken);
  }
}

async function end() { await pool.end(); }

module.exports = { db, api, setSetting, resetSetting, resetAllSettings, DEFAULTS, end, BASE };
