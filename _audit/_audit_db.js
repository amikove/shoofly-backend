// Script temporaire d'audit — exécute du SQL arbitraire et imprime le résultat en JSON.
// Usage: node _audit_db.js "SELECT * FROM settings"
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const sql = process.argv[2];
  try {
    const res = await pool.query(sql);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (e) {
    console.error('SQL ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
