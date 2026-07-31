const { Pool } = require('pg');
require('dotenv').config();

let pool;

function getDb() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      // Sans ceci, une tentative de connexion qui ne répond jamais (DB injoignable) reste
      // ouverte indéfiniment et finit par épuiser le pool — voir checkDbConnection ci-dessous.
      connectionTimeoutMillis: 4000,
      // Défaut pg (10) trop juste : les 14 cron.schedule (index.js) n'ont aucun décalage entre
      // eux, donc plusieurs peuvent se réveiller au même tick (ex: toutes les heures rondes),
      // en plus du trafic HTTP/WebSocket qui partage le même pool (audit perf 2026-07-26).
      max: 15,
    });
  }
  return pool;
}

// Vérifie que la base répond réellement (utilisé par /health). Réutilise le pool existant
// (aucune connexion supplémentaire créée) et borne l'attente : si la DB ne répond pas dans le
// délai, on rejette plutôt que de bloquer indéfiniment.
async function checkDbConnection(db = getDb(), timeoutMs = 5000) {
  await Promise.race([
    db.query('SELECT 1'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DB health check timeout')), timeoutMs)),
  ]);
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
    -- Exclusion définitive du pool de candidats pour CETTE mission précise, quand l'Œil
    -- refuse explicitement la sollicitation de confirmation (advanceCandidateCascade) —
    -- contrairement à un simple timeout (pas de réponse), qui n'exclut pas définitivement.
    ALTER TABLE mission_interests ADD COLUMN IF NOT EXISTS declined BOOLEAN NOT NULL DEFAULT FALSE;
    -- Cascade de réattribution PAR LOT (voir advanceCandidateCascade, routes/missions.js) :
    -- solicited_at marque qu'une ligne fait partie du lot actuellement sollicité (posé au
    -- tirage d'un nouveau lot, remis à NULL avant chaque nouveau tirage pour ne jamais
    -- laisser fuiter l'appartenance à un cycle précédent résolu-puis-rouvert) ; confirmed_at
    -- enregistre la confirmation de disponibilité SANS assignation immédiate — l'assignation
    -- est tranchée par la fenêtre de départage (missions.batch_tiebreak_ends_at ci-dessous).
    ALTER TABLE mission_interests ADD COLUMN IF NOT EXISTS solicited_at TIMESTAMPTZ;
    ALTER TABLE mission_interests ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
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
        ('accept_delay', '15'),
        ('transfer_grace_minutes_queue', '45'),
        ('transfer_grace_minutes_other', '60'),
        ('candidate_window_minutes_fast', '10'),
        ('candidate_window_minutes_choose_queue', '5'),
        ('candidate_window_minutes_choose_other', '10'),
        ('mission_edit_approval_minutes', '120'),
        ('mission_edit_approval_minutes_urgent', '30'),
        ('mission_edit_urgent_threshold_hours', '4'),
        ('client_validation_hours', '12'),
        ('schedule_conflict_window_hours', '4'),
        ('transfer_cooldown_hours', '4'),
        ('transfer_cooldown_before_hours', '3'),
        ('abandon_during_mission_cooldown_hours', '48'),
        ('stale_mission_hours', '12'),
        ('stale_mission_min_lead_hours', '4'),
        ('mission_overdue_verification_hours', '24'),
        ('late_start_alert_window_minutes', '30'),
        ('late_start_auto_transfer_minutes', '60'),
        ('reminder_before_mission_minutes_early', '120'),
        ('reminder_before_mission_minutes_late', '45'),
        ('refund_partial_threshold_hours', '2'),
        ('refund_partial_rate', '0.5'),
        ('new_oeil_mission_threshold', '10'),
        ('reactivation_default_score', '70'),
        ('ticket_auto_resolve_hours', '72'),
        ('response_time_max_valid_minutes', '1440'),
        ('response_time_min_turns', '3'),
        ('dashboard_stuck_pending_hours', '24'),
        ('dashboard_low_reliability_threshold', '70'),
        ('candidate_confirmation_minutes', '10'),
        ('presence_confirmation_deadline_minutes', '120'),
        ('presence_confirmation_deadline_minutes_sameday', '45'),
        ('candidate_batch_size', '10'),
        ('candidate_tiebreak_window_minutes', '5'),
        ('payment_attempt_abandoned_minutes', '30'),
        ('urgent_mission_whatsapp_batch_size', '10'),
        ('urgent_mission_whatsapp_batch_delay_minutes', '30'),
        ('whatsapp_retry_max_attempts', '3')
      ON CONFLICT (key) DO NOTHING;

    -- Migration ponctuelle (chantier confirmation H-2/H-45) : le INSERT ci-dessus ne change
    -- jamais une valeur déjà seedée (ON CONFLICT DO NOTHING), donc toute base déjà initialisée
    -- avant ce déploiement resterait silencieusement à l'ancien défaut ('30') sans cette ligne.
    -- Gardée par "AND value='30'" : ne s'applique qu'une fois (idempotente) et ne touche jamais
    -- une valeur qu'un admin aurait déjà personnalisée volontairement.
    UPDATE settings SET value='45' WHERE key='reminder_before_mission_minutes_late' AND value='30';

    -- Migration ponctuelle (correctif ancrage cooldown 'before', 2026-07-30) : ce réglage a changé
    -- de sens, pas seulement de valeur (voir commentaire sur le cooldown 'before' dans
    -- releaseMissionForReplacement, routes/missions.js) — il n'est plus une durée simple depuis
    -- l'instant du clic mais une extension au-delà de l'ancre (scheduled_at - 1h, ou maintenant si
    -- déjà dépassée). Même garde idempotente "AND value=ancien défaut" que la migration
    -- reminder_before_mission_minutes_late ci-dessus : ne s'applique qu'une fois et ne touche
    -- jamais une valeur qu'un admin aurait déjà personnalisée.
    UPDATE settings SET value='3' WHERE key='transfer_cooldown_before_hours' AND value='2';

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
    ALTER TABLE missions DROP COLUMN IF EXISTS claim_comment; -- colonne morte, jamais utilisée (le vrai commentaire de réclamation est dans claims.comment)
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
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS replacement_preference TEXT NOT NULL DEFAULT 'fast' CHECK(replacement_preference IN ('fast','choose'));
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS candidate_window_ends_at TIMESTAMPTZ;
    -- Candidat le mieux classé du lot actuellement sollicité — à titre indicatif seulement
    -- depuis le passage à la cascade PAR LOT (candidate_batch_size candidats simultanés, voir
    -- advanceCandidateCascade et batch_tiebreak_ends_at ci-dessous) : l'autorisation de
    -- confirmation/refus d'un candidat repose sur mission_interests.solicited_at, pas sur ce
    -- champ. candidate_window_ends_at porte désormais la deadline du LOT entier (partagée par
    -- tous ses membres), plus la fenêtre fast/choose historique, neutralisée — voir
    -- replacement_preference ci-dessus, contenu désormais ignoré).
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS pending_candidate_id TEXT REFERENCES users(id);
    -- Posée sur la mission dès la PREMIÈRE confirmation reçue dans le lot en cours (SOUS GARDE
    -- IS NULL — fenêtre fixe depuis la 1ère confirmation, jamais repoussée par les suivantes) ;
    -- à son expiration, on tranche entre tous les candidats confirmés avant cette échéance
    -- (reliability_score DESC, rating_avg DESC) via hireOeilCore. Ce traitement est prioritaire
    -- sur le timeout de lot complet (candidate_window_ends_at) — voir cron dédié dans index.js.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS batch_tiebreak_ends_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS transfer_cooldown_until TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reliability_score INTEGER NOT NULL DEFAULT 90;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS transfer_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS transfer_no_replacement_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]';

    -- Confirmation active de présence — demandée au rappel J-1 20h, ou à défaut (mission
    -- assignée le jour même, jamais passée par le rappel J-1) au rappel H-2 existant (voir
    -- index.js et checkPresenceConfirmationDeadlines ci-dessous, routes/missions.js).
    -- Remise à NULL sur toute nouvelle attribution d'oeil_id (POST /:id/accept, assign-admin,
    -- hireOeilCore) pour qu'un remplaçant reparte sur un cycle de confirmation propre plutôt
    -- que d'hériter de la deadline déjà expirée de l'Œil précédent.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS presence_confirmation_requested_at TIMESTAMPTZ;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS presence_confirmation_deadline_at TIMESTAMPTZ;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS presence_confirmed_at TIMESTAMPTZ;

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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;


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
    ALTER TABLE reliability_events ADD COLUMN IF NOT EXISTS is_reset BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS stale_notified_at TIMESTAMPTZ;

    -- Index de performance sur les colonnes fréquemment filtrées/jointes
    CREATE INDEX IF NOT EXISTS idx_withdrawals_oeil_id ON withdrawals(oeil_id);
    CREATE INDEX IF NOT EXISTS idx_identity_documents_user_id ON identity_documents(user_id);
    CREATE INDEX IF NOT EXISTS idx_ratings_oeil_id ON ratings(oeil_id);
    CREATE INDEX IF NOT EXISTS idx_ratings_client_id ON ratings(client_id);

    -- Audit perf 2026-07-26 : missions.city et users.role n'avaient aucun index. Composites
    -- (pas simples) car toujours filtrés ensemble dans les requêtes à fort volume : le feed
    -- "missions disponibles" (GET /missions?mode=available, status='pending' AND city=$1) et
    -- le pool WhatsApp missions urgentes (sendUrgentWhatsAppWave, role='oeil' AND city=$1).
    CREATE INDEX IF NOT EXISTS idx_missions_status_city ON missions(status, city);
    CREATE INDEX IF NOT EXISTS idx_users_role_city ON users(role, city);

    -- Chaîne de transferts en cours de mission (transfer_type='during') : une ligne par Œil ayant
    -- porté la mission, avec sa portion de temps réel — permet un split des gains au prorata,
    -- peu importe le nombre de transferts (remplace l'ancien split 50/50 figé à 2 Œils).
    CREATE TABLE IF NOT EXISTS mission_transfer_chain (
      id             SERIAL PRIMARY KEY,
      mission_id     TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      oeil_id        TEXT NOT NULL REFERENCES users(id),
      started_at     TIMESTAMPTZ NOT NULL,
      ended_at       TIMESTAMPTZ,
      earning_share  NUMERIC(10,2),
      sequence_order INTEGER NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_transfer_chain_mission_id ON mission_transfer_chain(mission_id);

    -- Système de tickets de support : fil de discussion bidirectionnel (remplace à terme
    -- mission_problem_reports, laissée en place pour l'instant — voir routes/tickets.js).
    CREATE TABLE IF NOT EXISTS support_tickets (
      id                     TEXT PRIMARY KEY,
      reference              TEXT UNIQUE NOT NULL,
      user_id                TEXT NOT NULL REFERENCES users(id),
      user_role              TEXT NOT NULL CHECK(user_role IN ('client','oeil')),
      category               TEXT NOT NULL CHECK(category IN (
        'mission','paiement','compte','facturation','verification','securite',
        'application','assistance_technique','confidentialite','reclamation',
        'suggestion','urgence','autre'
      )),
      subcategory            TEXT,
      mission_id             TEXT REFERENCES missions(id),
      initial_message        TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','dismissed')),
      is_urgent              BOOLEAN NOT NULL DEFAULT FALSE,
      last_admin_message_at  TIMESTAMPTZ,
      last_user_message_at   TIMESTAMPTZ,
      resolved_at            TIMESTAMPTZ,
      resolved_by            TEXT REFERENCES users(id),
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON support_tickets(user_id);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);

    CREATE TABLE IF NOT EXISTS ticket_messages (
      id          SERIAL PRIMARY KEY,
      ticket_id   TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender_id   TEXT NOT NULL REFERENCES users(id),
      sender_role TEXT NOT NULL CHECK(sender_role IN ('client','oeil','admin')),
      content     TEXT NOT NULL,
      is_system   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_id ON ticket_messages(ticket_id);
    -- Nécessaire pour réutiliser le pattern "marquer comme lu" de mission_messages
    -- (voir GET /tickets/:id) — absent du schéma minimal initial de l'étape 1.
    ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;

    -- Champs à choix fermé (<select>) du formulaire d'inscription — jamais validés côté
    -- serveur jusqu'ici (même trou que city/quartier, corrigé séparément). NOT VALID : on
    -- protège tous les nouveaux inserts/updates immédiatement sans forcer un scan bloquant
    -- des lignes existantes au démarrage (une valeur historique hors liste ne doit pas
    -- empêcher l'appli de démarrer) ; VALIDATE CONSTRAINT pourra être lancé plus tard à part.
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_profil_check;
    ALTER TABLE users ADD CONSTRAINT users_profil_check CHECK (profil IN (
      'Particulier','Entrepreneur / Chef d''entreprise','Professionnel / Salarié',
      'Expatrié / Non-résident (MRE)','Étudiant','Investisseur immobilier',
      'Profession libérale (avocat, médecin, architecte...)','Autre'
    )) NOT VALID;

    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_situation_check;
    ALTER TABLE users ADD CONSTRAINT users_situation_check CHECK (situation IN (
      'Étudiant','Salarié','Freelance','Auto-entrepreneur','En recherche d''emploi','Retraité','Autre'
    )) NOT VALID;

    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_motivation_check;
    ALTER TABLE users ADD CONSTRAINT users_motivation_check CHECK (motivation IN (
      'Revenu complémentaire','Revenu principal','Expérience professionnelle','Flexibilité','Autre'
    )) NOT VALID;

    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_usage_reason_check;
    ALTER TABLE users ADD CONSTRAINT users_usage_reason_check CHECK (usage_reason IN (
      'Gagner du temps','Éviter un déplacement','Vérifier avant un achat',
      'Gérer une démarche administrative','Superviser une activité à distance','Autre'
    )) NOT VALID;

    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_usage_frequency_check;
    ALTER TABLE users ADD CONSTRAINT users_usage_frequency_check CHECK (usage_frequency IN (
      'Une seule fois','Quelques fois par an','Une fois par mois','Plusieurs fois par mois','Chaque semaine'
    )) NOT VALID;

    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_disponibilite_check;
    ALTER TABLE users ADD CONSTRAINT users_disponibilite_check CHECK (disponibilite IN (
      'En semaine','Soirs','Week-ends','Temps plein'
    )) NOT VALID;

    -- Demandes de modification de mission après création, quand la mission est déjà assignée
    -- (approbation requise de l'Œil concerné avant application des changements proposés).
    -- Statut 'pending' : mission encore modifiable directement, pas de ligne créée ici.
    CREATE TABLE IF NOT EXISTS mission_edit_requests (
      id                SERIAL PRIMARY KEY,
      mission_id        TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      requested_by      TEXT NOT NULL REFERENCES users(id),
      proposed_changes  JSONB NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired')),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ NOT NULL,
      resolved_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_mission_edit_requests_mission ON mission_edit_requests(mission_id);
    CREATE INDEX IF NOT EXISTS idx_mission_edit_requests_status ON mission_edit_requests(status, expires_at);

    -- Filet de sécurité contre un solde négatif (ex: retraits concurrents non sérialisés) :
    -- vérifié en amont (aucune ligne existante hors limite), donc validation immédiate sûre au démarrage.
    ALTER TABLE oeil_profiles DROP CONSTRAINT IF EXISTS oeil_profiles_balance_check;
    ALTER TABLE oeil_profiles ADD CONSTRAINT oeil_profiles_balance_check CHECK(balance >= 0);

    -- Même filet côté client (users.balance, crédité par les remboursements) : même
    -- vérification préalable faite (aucune ligne négative), même validation immédiate.
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_balance_check;
    ALTER TABLE users ADD CONSTRAINT users_balance_check CHECK(balance >= 0);

    -- Paiement client réel via PayZone (sandbox) — la mission n'est créée qu'à la confirmation
    -- du paiement (callback webhook), jamais au moment du formulaire. mission_payload contient
    -- les données du formulaire déjà validées/tarifées au moment de l'init (voir POST
    -- /payments/payzone/init, routes/payments.js) — rejouées telles quelles à la confirmation,
    -- jamais re-validées/re-tarifées, pour garantir que le montant réellement facturé via
    -- PayZone correspond exactement à la mission créée.
    CREATE TABLE IF NOT EXISTS mission_payment_attempts (
      id              SERIAL PRIMARY KEY,
      client_id       TEXT NOT NULL REFERENCES users(id),
      mission_payload JSONB NOT NULL,
      price           NUMERIC(10,2) NOT NULL,
      charge_id       TEXT UNIQUE NOT NULL,
      status          TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','charged','declined','error')),
      mission_id      TEXT REFERENCES missions(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_payment_attempts_client ON mission_payment_attempts(client_id);
    CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON mission_payment_attempts(status);

    -- Mesure de l'ampleur du non-bancarisé chez les Œils (aucune solution de paiement
    -- alternative construite pour l'instant, juste la collecte de donnée). Nullable et sans
    -- défaut, à dessein : NULL = jamais répondu, distinct de FALSE = a explicitement déclaré
    -- ne pas avoir de compte bancaire. Renseigné via PUT /auth/me (voir routes/auth.js).
    ALTER TABLE oeil_profiles ADD COLUMN IF NOT EXISTS has_bank_account BOOLEAN;

    -- Vagues WhatsApp pour les missions urgentes (notifyNewMission) — évite d'envoyer un
    -- WhatsApp (facturé par Wasel) à tous les Œils disponibles de la ville en une seule fois.
    -- À la création, seuls les urgent_mission_whatsapp_batch_size premiers Œils éligibles
    -- (classés reliability_score DESC, rating_avg DESC) sont contactés par WhatsApp ; la
    -- notification in-app, elle, part toujours à tous immédiatement (inchangée). Si la mission
    -- reste sans oeil_id après urgent_mission_whatsapp_batch_delay_minutes, le cron dédié
    -- (index.js) envoie une nouvelle vague aux Œils éligibles pas encore contactés — voir
    -- sendUrgentWhatsAppWave, routes/missions.js.
    CREATE TABLE IF NOT EXISTS mission_whatsapp_contacts (
      mission_id   TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      oeil_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contacted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (mission_id, oeil_id)
    );
    -- Prochaine vague programmée (NULL = aucune vague en attente : mission non urgente, déjà
    -- assignée, ou pool épuisé). Nullée sur toute nouvelle attribution d'oeil_id (POST
    -- /:id/accept, assign-admin, hireOeilCore), même principe que candidate_window_ends_at.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS urgent_whatsapp_next_wave_at TIMESTAMPTZ;

    -- Filtrage WhatsApp 2026-07-25 — un seul WhatsApp "nouvelle candidature" par mission
    -- (jamais un envoi par candidature individuelle), déclenché dès que le nombre de
    -- candidatures atteint candidature_whatsapp_seuil_count (POST /:id/interest,
    -- routes/missions.js) ou, à défaut, après candidature_whatsapp_seuil_minutes depuis la
    -- première candidature (cron dédié, index.js). NULL = pas encore envoyé pour cette mission.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS candidature_whatsapp_sent_at TIMESTAMPTZ;

    -- Flux "Demander assistance" (2026-07-28) — point d'entrée unique pour un Œil assigné qui
    -- ne peut pas honorer sa mission comme prévu, remplaçant l'accès direct à /refuse et
    -- /status{cancelled}. Une ligne par déclaration : category='urgence' (accident, agression,
    -- hospitalisation, situation dangereuse) déclenche IMMÉDIATEMENT advanceCandidateCascade
    -- (via releaseMissionForReplacement, réutilisé de /:id/transfer) — status='triggered' posé
    -- directement, aucune validation requise. category='mission' (client absent/injoignable,
    -- mauvaise adresse, mission différente de la description) exige une validation du client :
    -- status='pending' jusqu'à réponse (ou expiration, voir expires_at) ; POST /:id/assistance/
    -- respond bascule vers 'validated' (mission clôturée, Œil payé intégralement) ou 'disputed'
    -- (ticket litige + entrée claims créés, mission gelée en sous_reclamation jusqu'à arbitrage
    -- admin via la route existante PUT /admin/claims/:missionId/resolve, réutilisée telle
    -- quelle) ; 'auto_validated' si le délai expire sans réponse (voir
    -- checkAssistanceRequestExpiry, routes/missions.js — même principe que
    -- autoValidateMissions.js : silence du client = acceptation).
    CREATE TABLE IF NOT EXISTS mission_assistance_requests (
      id                SERIAL PRIMARY KEY,
      mission_id        TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      oeil_id           TEXT NOT NULL REFERENCES users(id),
      category          TEXT NOT NULL CHECK(category IN ('urgence','mission')),
      reason            TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','validated','disputed','auto_validated','triggered')),
      transfer_type     TEXT, -- 'before'/'during' — traçabilité du mécanisme utilisé (catégorie urgence uniquement)
      support_ticket_id TEXT REFERENCES support_tickets(id),
      client_comment    TEXT,
      expires_at        TIMESTAMPTZ,
      responded_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_assistance_requests_mission ON mission_assistance_requests(mission_id);
    CREATE INDEX IF NOT EXISTS idx_assistance_requests_status_expires ON mission_assistance_requests(status, expires_at);

    -- Visibilité admin + retry automatique sur les échecs d'envoi WhatsApp (Wasel) — voir
    -- sendWhatsAppTemplate (services/wasel.js) et le cron de retry (jobs/whatsappRetry.js).
    -- Une ligne par tentative d'envoi ayant réellement échoué (HTTP en erreur ou exception
    -- réseau) — jamais pour les gardes de configuration en amont (clé API absente, téléphone
    -- manquant), qui ne sont pas de vraies tentatives d'envoi. retry_count compte les
    -- RETENTATIVES du cron (pas la tentative initiale qui a créé la ligne) ; resolved_at est
    -- posé dès qu'une retentative réussit — la ligne n'est jamais supprimée (trace conservée).
    CREATE TABLE IF NOT EXISTS whatsapp_send_failures (
      id            SERIAL PRIMARY KEY,
      template_name TEXT NOT NULL,
      phone         TEXT NOT NULL,
      variables     JSONB NOT NULL DEFAULT '[]',
      error_message TEXT NOT NULL,
      retry_count   INTEGER NOT NULL DEFAULT 0,
      resolved_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Index partiel : le cron de retry et la vue admin par défaut filtrent tous deux sur
    -- resolved_at IS NULL — même principe que idx_missions_status_city (audit perf 2026-07-26).
    CREATE INDEX IF NOT EXISTS idx_whatsapp_failures_unresolved ON whatsapp_send_failures(created_at) WHERE resolved_at IS NULL;

    -- Rappels client avant mission (2026-07-30) — purement informatifs, sans deadline de
    -- confirmation (contrairement aux colonnes presence_confirmation_* ci-dessus, qui sont
    -- spécifiques au mécanisme de présence de l'Œil). Une colonne dédiée par palier, même
    -- principe que stale_notified_at / candidature_whatsapp_sent_at : NULL = jamais envoyé,
    -- posée après l'envoi pour empêcher un doublon si le cron retombe sur la même fenêtre.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS client_reminder_j1_sent_at TIMESTAMPTZ;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS client_reminder_h2_sent_at TIMESTAMPTZ;

    -- Délai de grâce lecture seule sur le chat après clôture (2026-07-31). Posée par
    -- transitionMission() (missionStateMachine.js) à CHAQUE transition vers completed/cancelled,
    -- quel que soit le chemin (6 sites d'appel / 5 chemins produit) plutôt qu'en extraFields
    -- dupliqué par site : completed_at/cancelled_at ci-dessus ont justement démontré cette
    -- fragilité (posés de façon fiable sur seulement 2 des 6 sites avant ce correctif — les 4
    -- autres n'écrivaient que validated_at/is_priority). Ré-écrite à chaque (ré)clôture, y
    -- compris après un passage par sous_reclamation, pour repartir de la clôture la plus
    -- récente. Exposée en API sous chat_access_expires_at (closed_at + 24h — voir GET /:id,
    -- GET /missions, GET /missions/inbox). POST /:id/messages (blocage d'envoi) reste inchangé,
    -- aucun lien avec cette colonne.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

    -- Verrou structurel sur balance (2026-07-31, suite audit externe "ledger-only") : jusqu'ici
    -- rien n'empêchait une route d'écrire UPDATE oeil_profiles/users SET balance=... directement,
    -- sans passer par walletService (c'est exactement le bug FAIL1 déjà corrigé une fois — retrait
    -- refusé recrédité par UPDATE brut, sans ligne wallet_transactions correspondante). Plutôt que
    -- de compter sur la discipline de chaque futur appelant, ce trigger rejette toute écriture sur
    -- balance qui n'a pas posé au préalable SET LOCAL app.wallet_write_allowed='true' dans la même
    -- transaction — flag posé uniquement par walletService.credit()/debit() (services/walletService.js),
    -- jamais exposé ailleurs. SET LOCAL se réinitialise automatiquement à la fin de la transaction
    -- (COMMIT ou ROLLBACK), donc aucune remise à zéro manuelle n'est nécessaire. current_setting(...,
    -- true) renvoie NULL (jamais une erreur) si le flag n'a jamais été posé dans la session — c'est
    -- le cas par défaut, donc le comportement est bien "refusé sauf autorisation explicite".
    -- Portée volontairement limitée à UPDATE (le vecteur de FAIL1 et de la demande d'audit) : un
    -- INSERT avec un solde non nul (seed.js, dev uniquement, jamais en production) reste hors
    -- périmètre de ce trigger — voir RAPPORT_VERROUILLAGE_BALANCE.md pour la justification.
    CREATE OR REPLACE FUNCTION enforce_wallet_balance_guard() RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.wallet_write_allowed', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'balance ne peut être modifiée que via walletService.credit()/debit() (table %)', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS oeil_profiles_balance_guard ON oeil_profiles;
    CREATE TRIGGER oeil_profiles_balance_guard
      BEFORE UPDATE OF balance ON oeil_profiles
      FOR EACH ROW WHEN (NEW.balance IS DISTINCT FROM OLD.balance)
      EXECUTE FUNCTION enforce_wallet_balance_guard();

    DROP TRIGGER IF EXISTS users_balance_guard ON users;
    CREATE TRIGGER users_balance_guard
      BEFORE UPDATE OF balance ON users
      FOR EACH ROW WHEN (NEW.balance IS DISTINCT FROM OLD.balance)
      EXECUTE FUNCTION enforce_wallet_balance_guard();
  `);
  console.log('✅ PostgreSQL schema ready');
}
module.exports = { getDb, initDb, checkDbConnection };
