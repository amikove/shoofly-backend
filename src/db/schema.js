const { Pool } = require('pg');
require('dotenv').config();

let pool;

function getDb() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

async function initDb() {
  const db = getDb();
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      password    TEXT NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('client','oeil','admin')),
      first_name  TEXT NOT NULL,
      last_name   TEXT NOT NULL,
      phone       TEXT,
      city        TEXT,
      avatar_url  TEXT,
      is_active   BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS oeil_profiles (
      user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      bio             TEXT,
      coverage_zone   TEXT,
      is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
      is_available    BOOLEAN NOT NULL DEFAULT TRUE,
      rating_avg      NUMERIC(3,1) NOT NULL DEFAULT 0,
      rating_count    INTEGER NOT NULL DEFAULT 0,
      total_missions  INTEGER NOT NULL DEFAULT 0,
      total_earnings  NUMERIC(10,2) NOT NULL DEFAULT 0,
      balance         NUMERIC(10,2) NOT NULL DEFAULT 0,
      id_verified_at  TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS oeil_availability (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
      start_time  TEXT NOT NULL,
      end_time    TEXT NOT NULL,
      is_active   BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS missions (
      id            TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL REFERENCES users(id),
      oeil_id       TEXT REFERENCES users(id),
      type          TEXT NOT NULL CHECK(type IN ('immobilier','file_attente','audit','personnalisee')),
      subcategory   VARCHAR(150),
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','assigned','en_route','active','completed','cancelled','sous_reclamation')),
      title         TEXT NOT NULL,
      description   TEXT,
      address       TEXT NOT NULL,
      city          TEXT NOT NULL,
      scheduled_at  TIMESTAMPTZ NOT NULL,
      duration_est  INTEGER,
      price         NUMERIC(10,2),
      commission    NUMERIC(10,2),
      oeil_earning  NUMERIC(10,2),
      is_urgent     BOOLEAN NOT NULL DEFAULT FALSE,
      property_type TEXT,
      visit_type    TEXT,
      video_call    BOOLEAN DEFAULT FALSE,
      institution   TEXT,
      purpose       TEXT,
      company_name  TEXT,
      audit_type    TEXT,
      frequency     TEXT,
      criteria      TEXT,
      oeil_lat      NUMERIC(10,6),
      oeil_lng      NUMERIC(10,6),
      oeil_location_at TIMESTAMPTZ,
      assigned_at   TIMESTAMPTZ,
      started_at    TIMESTAMPTZ,
      completed_at  TIMESTAMPTZ,
      cancelled_at  TIMESTAMPTZ,
      cancel_reason TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mission_media (
      id          SERIAL PRIMARY KEY,
      mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      uploader_id TEXT NOT NULL REFERENCES users(id),
      type        TEXT NOT NULL CHECK(type IN ('photo','video','document')),
      filename    TEXT NOT NULL,
      url         TEXT NOT NULL,
      size_bytes  INTEGER,
      caption     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mission_messages (
      id          SERIAL PRIMARY KEY,
      mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      sender_id   TEXT NOT NULL REFERENCES users(id),
      content     TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text','system','location')),
      is_read     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mission_reports (
      id          SERIAL PRIMARY KEY,
      mission_id  TEXT UNIQUE NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      summary     TEXT,
      risk_points JSONB DEFAULT '[]',
      score       INTEGER CHECK(score BETWEEN 0 AND 100),
      notes       TEXT,
      created_by  TEXT NOT NULL REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ratings (
      id          SERIAL PRIMARY KEY,
      mission_id  TEXT UNIQUE NOT NULL REFERENCES missions(id),
      client_id   TEXT NOT NULL REFERENCES users(id),
      oeil_id     TEXT NOT NULL REFERENCES users(id),
      score       INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
      comment     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'info',
      mission_id  TEXT REFERENCES missions(id),
      is_read     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS favorites (
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      oeil_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (client_id, oeil_id)
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id           SERIAL PRIMARY KEY,
      oeil_id      TEXT NOT NULL REFERENCES users(id),
      amount       NUMERIC(10,2) NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected')),
      bank_info    JSONB,
      processed_by TEXT REFERENCES users(id),
      processed_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

CREATE INDEX IF NOT EXISTS idx_missions_client ON missions(client_id);
    CREATE INDEX IF NOT EXISTS idx_missions_oeil   ON missions(oeil_id);
    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
    CREATE INDEX IF NOT EXISTS idx_messages_mission ON mission_messages(mission_id);
    CREATE INDEX IF NOT EXISTS idx_notifs_user ON notifications(user_id, is_read);

    CREATE TABLE IF NOT EXISTS mission_interests (
  id         SERIAL PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  oeil_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(mission_id, oeil_id)
);

CREATE INDEX IF NOT EXISTS idx_interests_mission ON mission_interests(mission_id);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS quartier TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profil TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_reason TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_frequency TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS villes_cibles TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS situation TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS disponibilite TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS motivation TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS disponibilites JSONB;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT false;
    CREATE TABLE IF NOT EXISTS airbnb_reports (
  id          SERIAL PRIMARY KEY,
  mission_id  TEXT UNIQUE NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  oeil_id     TEXT NOT NULL REFERENCES users(id),
  data        JSONB NOT NULL DEFAULT '{}',
  score       INTEGER,
  submitted   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO settings (key, value) VALUES
        ('commission', '0.20'),
        ('min_price', '80'),
        ('urgency_fee', '0.30'),
        ('accept_delay', '15')
      ON CONFLICT (key) DO NOTHING;

    ALTER TABLE mission_messages ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT false;


    ALTER TABLE mission_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS mission_chat_seen (
    user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
    mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
    seen_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, mission_id)
  );

    ALTER TABLE missions DROP CONSTRAINT IF EXISTS missions_status_check;
    ALTER TABLE missions ADD CONSTRAINT missions_status_check CHECK(status IN ('pending','assigned','en_route','active','completed','cancelled','sous_reclamation'));

  CREATE TABLE IF NOT EXISTS mission_ignored (
  oeil_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (oeil_id, mission_id)
);

    CREATE TABLE IF NOT EXISTS mission_status_history (
      id          SERIAL PRIMARY KEY,
      mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      status      TEXT NOT NULL,
      changed_by  TEXT REFERENCES users(id),
      note        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS quartier VARCHAR(150);
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS subcategory VARCHAR(150);
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS completed_by_oeil_at TIMESTAMPTZ;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS claim_comment TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(10,2) NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type        TEXT NOT NULL CHECK(type IN ('credit','debit')),
      amount      NUMERIC(10,2) NOT NULL,
      reason      TEXT NOT NULL,
      mission_id  TEXT REFERENCES missions(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS claims (
      id          SERIAL PRIMARY KEY,
      mission_id  TEXT UNIQUE NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      client_id   TEXT NOT NULL REFERENCES users(id),
      comment     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved_oeil','resolved_client')),
      resolved_by TEXT REFERENCES users(id),
      resolved_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

CREATE TABLE IF NOT EXISTS identity_documents (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cin_recto   TEXT NOT NULL,
      cin_verso   TEXT NOT NULL,
      selfie      TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      rejected_reason TEXT,
      reviewed_by TEXT REFERENCES users(id),
      reviewed_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE oeil_profiles ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS is_priority BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS transfer_type TEXT CHECK(transfer_type IN ('before','during'));
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS transferred_from TEXT REFERENCES users(id);
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS transfer_reason TEXT;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS transfer_deadline TIMESTAMPTZ;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS oeil2_id TEXT REFERENCES users(id);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS transfer_cooldown_until TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reliability_score INTEGER NOT NULL DEFAULT 100;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS transfer_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS transfer_no_replacement_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]';

    CREATE TABLE IF NOT EXISTS promo_codes (
      id              SERIAL PRIMARY KEY,
      code            TEXT NOT NULL UNIQUE,
      type            TEXT NOT NULL CHECK(type IN ('percent','fixed','free')),
      value           NUMERIC(10,2) NOT NULL DEFAULT 0,
      max_uses        INTEGER,
      max_uses_per_user INTEGER NOT NULL DEFAULT 1,
      used_count      INTEGER NOT NULL DEFAULT 0,
      expires_at        TIMESTAMPTZ,
      platform_amount   NUMERIC(10,2),
      is_active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_by      TEXT REFERENCES users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS promo_uses (
      id          SERIAL PRIMARY KEY,
      promo_id    INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id),
      mission_id  TEXT REFERENCES missions(id),
      discount    NUMERIC(10,2) NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

  ALTER TABLE missions ADD COLUMN IF NOT EXISTS promo_code TEXT;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS discount NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS original_price NUMERIC(10,2);

    -- Système de score de fiabilité Œil
    CREATE TABLE IF NOT EXISTS reliability_events (
      id          SERIAL PRIMARY KEY,
      oeil_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mission_id  TEXT REFERENCES missions(id),
      points      INTEGER NOT NULL,
      reason      TEXT NOT NULL,
      is_grave    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT;


    -- Signalements de problèmes en cours de mission — table dédiée, séparée des rapports de visite
      -- (avant, les deux partageaient mission_reports avec une seule contrainte UNIQUE(mission_id),
      -- ce qui provoquait des écrasements silencieux entre rapport de visite et signalement)
      CREATE TABLE IF NOT EXISTS mission_problem_reports (
        id          SERIAL PRIMARY KEY,
        mission_id  TEXT UNIQUE NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        reporter_id TEXT NOT NULL REFERENCES users(id),
        reporter_role TEXT NOT NULL CHECK(reporter_role IN ('client','oeil')),
        type        TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','dismissed')),
        resolved_by TEXT REFERENCES users(id),
        resolved_at TIMESTAMPTZ,
        admin_note  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE missions ADD COLUMN IF NOT EXISTS under_surveillance BOOLEAN NOT NULL DEFAULT FALSE;

      -- Migration ponctuelle (ne s'exécute qu'une seule fois, à la première exécution après ce changement) :
      -- déplace les anciens signalements — mélangés jusqu'ici dans mission_reports — vers la nouvelle table.
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='mission_reports' AND column_name='reporter_id'
        ) THEN
          INSERT INTO mission_problem_reports (mission_id, reporter_id, reporter_role, type, description, status, resolved_by, resolved_at, admin_note, created_at)
          SELECT mission_id, reporter_id, reporter_role, type, description, status, resolved_by, resolved_at, admin_note, created_at
          FROM mission_reports
          WHERE reporter_id IS NOT NULL
          ON CONFLICT (mission_id) DO NOTHING;

          DELETE FROM mission_reports WHERE reporter_id IS NOT NULL;

          ALTER TABLE mission_reports DROP COLUMN reporter_id;
          ALTER TABLE mission_reports DROP COLUMN IF EXISTS reporter_role;
          ALTER TABLE mission_reports DROP COLUMN IF EXISTS type;
          ALTER TABLE mission_reports DROP COLUMN IF EXISTS description;
          ALTER TABLE mission_reports DROP COLUMN IF EXISTS status;
          ALTER TABLE mission_reports DROP COLUMN IF EXISTS resolved_by;
          ALTER TABLE mission_reports DROP COLUMN IF EXISTS resolved_at;
          ALTER TABLE mission_reports DROP COLUMN IF EXISTS admin_note;
        END IF;
      END $$;


    CREATE TABLE IF NOT EXISTS reliability_review_requests (
      id          SERIAL PRIMARY KEY,
      oeil_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      admin_response TEXT,
      reviewed_by TEXT REFERENCES users(id),
      reviewed_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id          SERIAL PRIMARY KEY,
      amount      NUMERIC(10,2) NOT NULL,
      category    TEXT NOT NULL,
      description TEXT,
      expense_date DATE NOT NULL,
      created_by  TEXT REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_source TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_medium TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_campaign TEXT;

    ALTER TABLE ratings ADD COLUMN IF NOT EXISTS nps_facilite INTEGER CHECK(nps_facilite BETWEEN 1 AND 5);
    ALTER TABLE ratings ADD COLUMN IF NOT EXISTS nps_reactivite INTEGER CHECK(nps_reactivite BETWEEN 1 AND 5);
    ALTER TABLE ratings ADD COLUMN IF NOT EXISTS nps_utilite INTEGER CHECK(nps_utilite BETWEEN 1 AND 5);
    ALTER TABLE ratings ADD COLUMN IF NOT EXISTS nps_recommandation INTEGER CHECK(nps_recommandation BETWEEN 1 AND 5);
    ALTER TABLE ratings ADD COLUMN IF NOT EXISTS platform_comment TEXT;

    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_type TEXT;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title_key TEXT;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS body_key TEXT;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS params JSONB;

    ALTER TABLE mission_messages ADD COLUMN IF NOT EXISTS content_key TEXT;
    ALTER TABLE mission_messages ADD COLUMN IF NOT EXISTS params JSONB;
  `);
  console.log('✅ PostgreSQL schema ready');
}
module.exports = { getDb, initDb };
