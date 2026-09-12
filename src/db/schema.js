const { Pool } = require('pg');
require('dotenv').config();
const SETTINGS_DEFAULTS = require('../config/settingsDefaults');
const SUBCATEGORY_MIN_PRICES_SEED = require('../config/subcategoryMinPricesSeed');

let pool;

function getDb() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      // Sans ceci, une tentative de connexion qui ne répond jamais (DB injoignable) reste
      // ouverte indéfiniment et finit par épuiser le pool — voir checkDbConnection ci-dessous.
      connectionTimeoutMillis: 4000,
      // Défaut pg (10) trop juste : les 24 cron.schedule (index.js) sont étalés sur des minutes
      // de déclenchement distinctes depuis RG11 (audit régression 360° v4) — au pire 4 ticks
      // coïncident (contre ~22 à la minute :00 auparavant), en plus du trafic HTTP/WebSocket qui
      // partage le même pool (audit perf 2026-07-26). max laissé à 15 : l'étalement a réduit la
      // demande de pointe des crons, 15 reste confortable, aucun re-dimensionnement requis.
      // NB perf 2026-09-07 (P2) : le rapport Performance recommande de RÉÉVALUER `max` en fonction
      // de la limite de connexions du plan Postgres Render réel (dashboard Render → Metrics),
      // information hors de portée d'une session Claude Code — laissé à 15, à ajuster côté opérateur.
      max: 15,
      // P2 (audit Performance 2026-09-07) — garde-fou contre la saturation du pool. Sans limite,
      // une requête « folle » (plan qui dérape, attente de verrou, réplica coincé) monopolise sa
      // connexion indéfiniment ; quelques-unes suffisent à remplir le pool (max 15) et TOUTE autre
      // requête, même triviale, tombe alors en 500 après connectionTimeoutMillis (564 timeouts
      // observés sous charge dans l'audit). 15 s = le timeout que le frontend s'impose déjà (axios
      // `timeout: 15000`, shoofly-react/src/api/client.js) : au-delà, la requête HTTP est de toute
      // façon abandonnée côté navigateur — Postgres cesse alors de brûler une connexion pour une
      // réponse que plus personne n'attend. Marge vérifiée EXPLAIN sur jeu 100k APRÈS les index
      // P1/P4 de ce chantier : requête légitime la plus lourde ≈ 640 ms (admin ?search=), dashboards
      // admin < 200 ms/requête → ~4× à 75× de marge même avec la pénalité CPU « ×2-5 » d'un plan
      // Render partagé (rapport §6). IMPORTANT : ce timeout et les index P1/P4 doivent partir dans
      // LE MÊME déploiement — sur le schéma actuel (sans index) l'audit a mesuré un ordre à 5058 ms
      // sous contention, qu'une pénalité Render ×3 pousserait vers 15 s. statement_timeout (côté
      // serveur : Postgres annule et rend la main, SQLSTATE 57014) et non query_timeout (minuteur
      // client qui n'annule pas la requête serveur). Aucun statement_timeout n'existait avant
      // (tracé : seul `SET LOCAL app.wallet_write_allowed` dans walletService, sans rapport).
      statement_timeout: 15000,
    });
    // pg émet 'error' sur le POOL quand un client INACTIF (au repos dans le pool, hors de toute
    // requête) tombe : coupure réseau, redémarrage ou timeout côté Postgres, RST TCP. Sans
    // écouteur, EventEmitter transforme cet 'error' en exception non interceptée qui remonte
    // jusqu'à process.on('uncaughtException') (index.js) → crashAndLog → process.exit(1) — tout
    // le service tombe pour un client au repos, alors qu'aucune requête active n'est en cause.
    // pg a déjà retiré ET fermé le client fautif du pool AVANT d'émettre (voir pg-pool
    // makeIdleListener : _remove(client) puis emit) et en recrée un à la demande au prochain
    // query() : le pool s'auto-répare, on se contente donc de journaliser. Même intention que le
    // req.on('error') du keep-alive Render (O-BE-1, index.js) — empêcher une erreur d'infra non
    // critique d'atteindre le filet de dernier recours.
    pool.on('error', (err) => {
      console.error(`❌ Pool PG — erreur sur client inactif (client retiré et remplacé automatiquement par pg) : ${err.message}`);
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
    -- Le pool impose statement_timeout=15s (P2, voir getDb ci-dessus). Ce bloc DDL est UNE seule
    -- requête simple multi-instructions → Postgres l'exécute dans une transaction implicite, donc
    -- SET LOCAL y a un effet et se réinitialise seul au COMMIT implicite (vérifié). On le neutralise
    -- ici : au démarrage sur une base déjà volumineuse, créer/valider un index ou une contrainte
    -- NOT VALID→VALIDATE peut légitimement dépasser 15 s, et un boot qui n'arrive pas à poser son
    -- schéma est bien pire qu'une requête runtime lente. Runtime : inchangé (SET LOCAL ne fuit pas).
    SET LOCAL statement_timeout = 0;

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
        ${Object.entries(SETTINGS_DEFAULTS).map(([k, v]) => `('${k}', '${v}')`).join(',\n        ')}
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
    -- Distingue une libération "sans faute" (URGENCE, suspension admin, confirmation de présence
    -- non reçue) d'un abandon ordinaire — checkTransferDeadlines lit ce flag pour ne jamais
    -- pénaliser (score ni argent) une mission qui provient d'un de ces 3 chemins, même si aucun
    -- remplaçant n'est trouvé avant l'échéance (RAPPORT_CORRECTIF_PENALITE_DIFFEREE.md). Flag
    -- explicite plutôt qu'une déduction depuis transferred_from : plus robuste, plus auditable.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS transfer_no_penalty BOOLEAN NOT NULL DEFAULT FALSE;
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
    -- PROMPT A (B2, 2026-08-18) : annulation intégrale d'une pénalité déjà appliquée (ex: reprise
    -- après transfert H+30) sans jamais supprimer/modifier l'événement d'origine. Posé UNIQUEMENT
    -- sur l'événement de compensation, pointant vers l'événement qu'il annule — voir
    -- reverseReliabilityEvent() (reliabilityScore.js), qui exclut la paire (origine + compensation)
    -- du calcul de computeReliabilityScore plutôt que de simplement additionner un delta opposé :
    -- computeReliabilityScore fait une MOYENNE (glissante 20 + historique), donc ajouter deux
    -- événements de poids opposés change le dénominateur et ne restaure pas exactement le score
    -- précédent (voir RAPPORT_PROMPT_A_RESUME_H30_ANNULATION.md) — seule l'exclusion totale de la
    -- paire garantit une restauration bit-à-bit, tout en gardant les deux lignes visibles dans tout
    -- historique consultant reliability_events directement (reliabilityRoutes.js, users.js).
    -- ON DELETE CASCADE (pas NO ACTION, le défaut) : cohérent avec oeil_id ci-dessus et le reste
    -- du schéma (cascade quasi-systématique) — permet à un DELETE FROM users de toujours nettoyer
    -- la paire origine+compensation ensemble dans le même cascade, sans ordre manuel requis (la
    -- suppression réelle d'un Œil n'arrive normalement jamais en production, hors nettoyage de
    -- fixtures de test).
    ALTER TABLE reliability_events ADD COLUMN IF NOT EXISTS reverses_event_id INTEGER REFERENCES reliability_events(id) ON DELETE CASCADE;
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

    -- ═══ Contraintes de plage sur les montants + unicité email casse-insensible ═══════════
    -- Audit BDD 2026-09-06 (rapport-audit-base-de-donnees-contraintes-index-transactions,
    -- §1 C1-C5 + C20 ; correctif : rapport-groupe1-contraintes-db-argent-doublons-2026-09-06).
    -- Jusqu'ici AUCUN CHECK ne bornait les colonnes d'argent — la base acceptait price=-100,
    -- une ligne de ledger amount=-50, un retrait <= 0 (tests §4 du rapport). walletService
    -- (montant > 0), prepareMissionInsert (body('price').isFloat({min:0})) et pricing() (setting
    -- 'commission' borné [0,1] par config/settingValidators.js) sont les SEULS remparts, purement
    -- applicatifs : un INSERT hors de ces chemins (régression, script, route future) corromprait
    -- directement le SUM(credit)-SUM(debit) que jobs/walletReconciliation.js compare à balance.
    --
    -- Patron (exigence du prompt de chantier) : ADD CONSTRAINT … NOT VALID puis VALIDATE
    -- CONSTRAINT, jamais un ADD direct qui prendrait un ACCESS EXCLUSIVE le temps du scan. Sous
    -- garde « constraint absente » : le scan de validation ne tourne qu'UNE fois, au déploiement
    -- qui introduit la contrainte ; les redémarrages suivants sautent le bloc entièrement
    -- (contrairement au DROP+ADD des *_balance_check ci-dessus, qui revalident à chaque boot —
    -- toléré sur oeil_profiles/users, pas sur missions/wallet_transactions qui croissent par
    -- mission / par mouvement). Données revérifiées avant pose (2026-09-06, PG local,
    -- BEGIN…ROLLBACK) : 0 ligne en violation sur chacune des 6.

    -- C1 — missions.price >= 0 (0 = mission gratuite, cas légitime existant) + NOT NULL. price
    -- est TOUJOURS renseigné : body('price').isFloat({min:0}) obligatoire (missions.js
    -- missionCreateValidators, partagé POST /missions + POST /payments/payzone/init), figé dans
    -- FORBIDDEN_EDIT_FIELDS, jamais écrit par transitionMission/applyMissionEditChanges (tous les
    -- extraFields tracés — aucun ne touche price/commission/oeil_earning) ; db/seed.js le
    -- renseigne sur ses 5 missions. NOT NULL posé en contrainte nommée NOT VALID (PG 17+) puis
    -- VALIDATE — même logique non-bloquante que les CHECK (attnotnull passe à true dès le ADD).
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'missions_price_check') THEN
        ALTER TABLE missions ADD CONSTRAINT missions_price_check CHECK (price >= 0) NOT VALID;
        ALTER TABLE missions VALIDATE CONSTRAINT missions_price_check;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'missions_price_not_null') THEN
        ALTER TABLE missions ADD CONSTRAINT missions_price_not_null NOT NULL price NOT VALID;
        ALTER TABLE missions VALIDATE CONSTRAINT missions_price_not_null;
      END IF;
    END $$;

    -- C2 / C3 — missions.commission / oeil_earning >= 0 (CHECK seul, PAS de NOT NULL). pricing()
    -- garantit commission ∈ [0, price] et oeil_earning = price - commission ∈ [0, price]. NOT NULL
    -- VOLONTAIREMENT reporté (ARRÊT signalé dans le rapport) : 1 ligne pré-git (mission
    -- 931ae019, créée 2026-06-17 — 3 jours avant le commit initial 72621a0 ; 'assigned' jamais
    -- validée, aucun mouvement wallet déclenché) a commission/oeil_earning NULL, ET db/seed.js
    -- (mission m5, dev uniquement) crée encore une mission sans ces colonnes. CHECK(>=0) laisse
    -- passer NULL (logique ternaire SQL) — ces lignes ne le violent pas. Marche à suivre NOT NULL
    -- (backfill 36.00 / 144.00 au taux 0.20 sur 931ae019 + correctif seed.js m5) dans le rapport.
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'missions_commission_check') THEN
        ALTER TABLE missions ADD CONSTRAINT missions_commission_check CHECK (commission >= 0) NOT VALID;
        ALTER TABLE missions VALIDATE CONSTRAINT missions_commission_check;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'missions_oeil_earning_check') THEN
        ALTER TABLE missions ADD CONSTRAINT missions_oeil_earning_check CHECK (oeil_earning >= 0) NOT VALID;
        ALTER TABLE missions VALIDATE CONSTRAINT missions_oeil_earning_check;
      END IF;
    END $$;

    -- C4 — wallet_transactions.amount >= 0 (PAS > 0). services/walletService.js credit()/debit()
    -- sont les SEULS writers (grep exhaustif : missions.js / users.js / index.js /
    -- walletReconciliation.js ne font que du SELECT) et lèvent tous deux sur !(amount > 0) ; les
    -- 3 sites de pénalité plafonnée (index.js H+30, missions.js checkTransferDeadlines,
    -- utils/cashCommission.js) gardent en plus un if (montant > 0). Les 20 lignes amount=0 en base
    -- sont du résidu historique : chemin INSERT direct plafonné-sans-garde (commit 155d0c9,
    -- 2026-07-17) supprimé le 2026-07-31 (commit 64a8011 — passage des pénalités par
    -- walletService) ; toutes sur comptes @test.local, fenêtre 17-20/07. Viser > 0 imposerait de
    -- statuer sur ces 20 lignes (décision produit, hors périmètre) ; >= 0 bloque déjà la vraie
    -- menace — le négatif (test empirique amount=-50 accepté avant) — sans les rejeter.
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_amount_check') THEN
        ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_amount_check CHECK (amount >= 0) NOT VALID;
        ALTER TABLE wallet_transactions VALIDATE CONSTRAINT wallet_transactions_amount_check;
      END IF;
    END $$;

    -- C5 — withdrawals.amount > 0. POST /oeil/withdraw (routes/users.js) est le seul writer hors
    -- db/seed.js : garde (!amount || amount < 100) en amont + walletService.debit (montant > 0)
    -- dans la même transaction avant l'INSERT — un retrait <= 0 est déjà triplement impossible.
    -- Filet DB en plus (le garde applicatif < 100 pourrait régresser ; une route future pourrait
    -- écrire ailleurs). UPDATE withdrawals ne touche jamais amount (status / processed_* seulement).
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'withdrawals_amount_check') THEN
        ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_amount_check CHECK (amount > 0) NOT VALID;
        ALTER TABLE withdrawals VALIDATE CONSTRAINT withdrawals_amount_check;
      END IF;
    END $$;

    -- C20 — users.email unicité insensible à la casse. users_email_key (UNIQUE btree) est
    -- sensible à la casse : KARIM@GMAIL.COM peut coexister avec karim@gmail.com (test §3 du
    -- rapport). register / login / forgot-password (routes/auth.js) normalisent tous via
    -- express-validator .normalizeEmail() — lowercase complet local + domaine (vérifié
    -- validator@13.15.35), écriture ET lecture cohérentes : cet index ne casse aucun login
    -- existant. Filet contre un chemin qui contournerait cette normalisation : POST
    -- /super-admin/admins (routes/superAdmin.js) stocke l'email BRUT et fait un dup-check
    -- sensible à la casse — signalé dans le rapport comme correctif applicatif séparé (ne bloque
    -- pas cet index : 0 collision lower(email) en base à ce jour). users_email_key est conservé
    -- (filet sur l'égalité exacte ; aucun code ne dépend de sa suppression).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

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

    -- Réconciliation automatique du solde (2026-07-31, suite au verrou ci-dessus) — le trigger
    -- empêche une NOUVELLE désynchronisation via UPDATE, mais ne détecte pas une désync déjà
    -- présente (ex: séquelle du bug FAIL1 avant son correctif, ou une INSERT avec solde non nul
    -- comme seed.js, volontairement hors périmètre du trigger — voir walletService.js). Ce cron
    -- (jobs/walletReconciliation.js) compare périodiquement, pour chaque utilisateur, SUM(credit)-
    -- SUM(debit) (wallet_transactions) à son solde stocké (oeil_profiles.balance ou users.balance,
    -- selon BALANCE_TABLE — voir walletService.js) et journalise tout écart, SANS jamais corriger
    -- automatiquement balance/wallet_transactions (lecture seule — une désync financière doit être
    -- investiguée par un humain avant toute correction, voir jobs/walletReconciliation.js).
    -- discrepancy = stored_balance - ledger_balance (positif = solde stocké supérieur au ledger,
    -- négatif = inférieur). Une ligne par écart NOUVELLEMENT détecté — pas de doublon tant qu'une
    -- ligne non résolue existe déjà pour le même utilisateur (vérifié via NOT EXISTS avant l'INSERT
    -- côté jobs/walletReconciliation.js). resolved_at n'est JAMAIS posé automatiquement par ce cron,
    -- même quand l'écart disparaît au run suivant (solde corrigé entre-temps) — uniquement par
    -- action admin explicite (PUT .../resolve) : que les montants se recroisent à nouveau ne prouve
    -- pas qu'un humain a compris et validé la cause, seulement qu'ils correspondent de nouveau
    -- (potentiellement via une nouvelle anomalie qui masquerait la première).
    CREATE TABLE IF NOT EXISTS wallet_reconciliation_alerts (
      id              SERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_type       TEXT NOT NULL CHECK(user_type IN ('oeil','client')),
      ledger_balance  NUMERIC(10,2) NOT NULL,
      stored_balance  NUMERIC(10,2) NOT NULL,
      discrepancy     NUMERIC(10,2) NOT NULL,
      detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at     TIMESTAMPTZ
    );
    -- Index partiel : le cron (anti-doublon NOT EXISTS) et la vue admin par défaut filtrent tous
    -- deux sur resolved_at IS NULL — même principe que idx_whatsapp_failures_unresolved ci-dessus.
    CREATE INDEX IF NOT EXISTS idx_wallet_reconciliation_unresolved ON wallet_reconciliation_alerts(detected_at) WHERE resolved_at IS NULL;

    -- Intégration CashPlus (2026-08-01) — recharge volontaire du wallet Œil en cash via agence,
    -- voir RECAP_INTEGRATION_CASHPLUS.md et services/cashplus.js. Une ligne par demande de
    -- génération de token, nécessaire pour l'idempotence du callback (POST /payments/cashplus/
    -- callback ne doit jamais créditer deux fois) et pour distinguer une demande jamais honorée
    -- (token simplement expiré, aucune action financière) d'une demande complétée. amount/fees
    -- sont figés ICI au moment de la génération et ne sont plus jamais recalculés ni fait
    -- confiance depuis le payload du callback ensuite — même principe que mission_payment_attempts
    -- pour PayZone : la source de vérité du montant crédité reste toujours ce que Shoofly a décidé,
    -- jamais un payload externe reçu plus tard. token/date_expiration sont nullable (posés
    -- seulement après réponse SUCCESS de CashPlus — voir routes/users.js, aucune ligne insérée
    -- si l'appel échoue, rien à suivre pour une tentative qui n'a jamais existé côté CashPlus).
    CREATE TABLE IF NOT EXISTS cashplus_recharge_requests (
      id              SERIAL PRIMARY KEY,
      request_id      TEXT UNIQUE NOT NULL,
      oeil_id         TEXT NOT NULL REFERENCES users(id),
      amount          NUMERIC(10,2) NOT NULL,
      fees            NUMERIC(10,2) NOT NULL,
      token           TEXT,
      date_expiration TIMESTAMPTZ,
      status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','expired')),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_cashplus_requests_oeil ON cashplus_recharge_requests(oeil_id);
    -- Index partiel : le cron d'expiration (jobs/cashplusExpiry.js) filtre exclusivement sur
    -- status='pending' — même principe que idx_whatsapp_failures_unresolved ci-dessus.
    CREATE INDEX IF NOT EXISTS idx_cashplus_requests_pending_expiry ON cashplus_recharge_requests(date_expiration) WHERE status='pending';

    -- "Mot de passe oublié" (2026-08-10) — 2 colonnes sur users plutôt qu'une table dédiée : au
    -- plus UN token actif par utilisateur à la fois (règle métier "dernier token demandé = seul
    -- valide"), donc une simple paire nullable suffit et rend cette invariante STRUCTURELLE
    -- plutôt qu'à faire respecter par une requête — une nouvelle demande écrase directement
    -- l'ancien hash/expiration (UPDATE), aucun DELETE explicite des anciens tokens nécessaire.
    -- Jamais le token en clair en base : password_reset_token_hash stocke un SHA-256 hex du
    -- token (généré via crypto.randomBytes côté route). PAS bcrypt comme pour les mots de passe
    -- utilisateur : bcrypt sale aléatoirement à chaque hash, ce qui empêche tout lookup direct
    -- (WHERE password_reset_token_hash=$1 ; il faudrait comparer ligne par ligne). SHA-256
    -- convient ici précisément parce que le token est déjà à haute entropie (32 octets
    -- crypto.randomBytes, jamais choisi/deviné par un humain) — la propriété recherchée est
    -- l'irréversibilité en cas de fuite de la base, pas la résistance au brute-force qui
    -- justifie un hash lent pour un mot de passe. Voir routes/auth.js (hashResetToken) et
    -- services/email.js (sendPasswordResetEmail). IMPORTANT : safe() dans routes/auth.js strip
    -- ces 2 colonnes de toute réponse — ne jamais les exposer via SELECT * + safe() sans vérifier
    -- que le strip est toujours en place si safe() est un jour modifié.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;
    -- Unique + partiel (comme idx_whatsapp_failures_unresolved) : accélère le lookup par token
    -- (reset-password) et garantit qu'une collision SHA-256 entre 2 utilisateurs — astronomiquement
    -- improbable mais pas structurellement impossible — échouerait bruyamment plutôt que de
    -- laisser un des deux tokens écraser silencieusement l'autre en recherche.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_password_reset_token_hash ON users(password_reset_token_hash) WHERE password_reset_token_hash IS NOT NULL;

    -- Modèle de paiement cash (2026-08-13) — voir RAPPORT_DIAGNOSTIC_COHERENCE_CASH_VS_PAYZONE.md.
    -- 'cash' : le client paie l'Œil directement en espèces, Shoofly n'encaisse jamais rien en
    -- ligne — au lieu de créditer oeil_earning à la validation (comme pour 'payzone'), Shoofly
    -- DÉBITE sa commission du wallet Œil (voir settleCashCommission, utils/cashCommission.js,
    -- appelée depuis POST /:id/validate et les autres points de validation, routes/missions.js).
    -- 'payzone' : comportement hérité strictement inchangé (paiement en ligne réel, jamais
    -- confirmé opérationnel en prod à ce jour — voir diagnostic cité ci-dessus).
    -- Nullable (pas de valeur par défaut, pas de backfill) : les missions déjà existantes avant
    -- cette migration restent à NULL, hors périmètre de cette session — seule la création de
    -- NOUVELLES missions impose cette valeur, en 400 côté API (prepareMissionInsert), jamais via
    -- une contrainte NOT NULL ici (même raisonnement que users_profil_check plus haut : ne jamais
    -- bloquer le démarrage sur des lignes historiques). CHECK ci-dessous : IN() laisse NULL passer
    -- (logique ternaire SQL), donc n'entrave pas les lignes historiques tout en bloquant déjà
    -- toute valeur future hors 'cash'/'payzone' — même motif que missions.transfer_type ci-dessus.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS payment_method TEXT CHECK(payment_method IN ('cash','payzone'));

    -- Manque à gagner sur la commission cash (2026-08-13) — décision produit : un solde Œil
    -- insuffisant à la validation ne bloque JAMAIS la mission (voir settleCashCommission) ; le
    -- débit est plafonné au solde disponible (jamais négatif — la contrainte CHECK(balance>=0)
    -- sur oeil_profiles, ci-dessus, reste intacte et n'a pas besoin d'être affaiblie) et toute
    -- différence entre la commission due et la commission réellement collectée est journalisée
    -- ici pour rester visible côté admin (voir GET/PUT .../admin/commission-shortfalls,
    -- routes/users.js) au lieu de rester invisible dans les seuls logs serveur. Volontairement
    -- une table séparée de wallet_reconciliation_alerts plutôt qu'une réutilisation : cette
    -- dernière signale un solde stocké qui NE CORRESPOND PAS au ledger (une anomalie/bug à
    -- investiguer) — un manque à gagner cash ne crée aucune divergence de ce type (balance et
    -- ledger avancent ensemble, du même montant réellement débité), ce serait donc sémantiquement
    -- faux d'y mélanger les deux et risquerait de noyer de vraies anomalies dans du bruit attendu.
    -- resolved_at : même contrat que wallet_reconciliation_alerts (jamais posé automatiquement,
    -- seulement par action admin explicite).
    CREATE TABLE IF NOT EXISTS mission_commission_shortfalls (
      id                    SERIAL PRIMARY KEY,
      mission_id            TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      oeil_id               TEXT NOT NULL REFERENCES users(id),
      commission_due        NUMERIC(10,2) NOT NULL,
      commission_collected  NUMERIC(10,2) NOT NULL,
      shortfall             NUMERIC(10,2) NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at           TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_commission_shortfalls_oeil ON mission_commission_shortfalls(oeil_id);
    -- Index partiel : même principe que idx_wallet_reconciliation_unresolved ci-dessus (le cron/
    -- la vue admin par défaut filtrent tous deux sur resolved_at IS NULL).
    CREATE INDEX IF NOT EXISTS idx_commission_shortfalls_unresolved ON mission_commission_shortfalls(created_at) WHERE resolved_at IS NULL;

    -- Verrou anti-double-création (PROMPT 1 point 4, 2026-08-17) — empêche un double-clic sur
    -- "Créer" (ou un retry réseau du frontend) de produire deux missions identiques. Empreinte
    -- calculée côté serveur sur les champs normalisés de la création (voir POST /missions,
    -- routes/missions.js) : aucune coopération du frontend requise (chantier backend seul, aucun
    -- header Idempotency-Key attendu). La contrainte UNIQUE (client_id, fingerprint) fait porter
    -- la déduplication par Postgres lui-même — seul moyen réellement sûr sous requêtes concurrentes
    -- (un simple SELECT-puis-INSERT applicatif laisserait une fenêtre de course ouverte entre les
    -- deux requêtes d'un double-clic). Lignes volontairement conservées après expiration de la
    -- fenêtre de déduplication (pas de cron de purge) : même choix que mission_status_history,
    -- table légère au regard du volume de missions déjà accepté ailleurs dans ce projet.
    CREATE TABLE IF NOT EXISTS mission_create_locks (
      client_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fingerprint  TEXT NOT NULL,
      mission_id   TEXT REFERENCES missions(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (client_id, fingerprint)
    );

    -- Trace d'audit des éditions admin sur une mission (PROMPT 1 point 2, 2026-08-17) — "qui, quoi,
    -- quand", cohérent avec la rigueur déjà exigée sur ce projet pour tout ce qui touche aux
    -- missions. La colonne changes stocke {champ: {from, to}} pour chaque champ réellement modifié
    -- — jamais price (verrouillé pour tout rôle, y compris super admin, voir PUT /missions/admin/:id) :
    -- le montant de commission bloqué sur le wallet Œil à la création (checkCashCommissionBalance)
    -- ne doit jamais pouvoir se retrouver désynchronisé d'un price modifié après coup.
    CREATE TABLE IF NOT EXISTS mission_admin_edits (
      id          SERIAL PRIMARY KEY,
      mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      admin_id    TEXT NOT NULL REFERENCES users(id),
      changes     JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mission_admin_edits_mission ON mission_admin_edits(mission_id);

    -- Le client peut désormais annuler lui-même sa demande de modification tant qu'elle est en
    -- attente (PROMPT 1 point 1, 2026-08-17) — voir POST /missions/edit-requests/:id/cancel.
    ALTER TABLE mission_edit_requests DROP CONSTRAINT IF EXISTS mission_edit_requests_status_check;
    ALTER TABLE mission_edit_requests ADD CONSTRAINT mission_edit_requests_status_check
      CHECK (status IN ('pending','approved','rejected','expired','cancelled')) NOT VALID;

    -- Requalification admin a posteriori d'une déclaration d'urgence (PROMPT 1 point 5,
    -- 2026-08-17, section 0/B4) — le chemin assistance/urgence reste sans pénalité au moment où
    -- l'Œil le déclenche (une urgence ne se juge pas en temps réel), mais un admin peut ensuite,
    -- depuis l'historique de l'Œil, requalifier une déclaration précise comme non légitime. Cela
    -- applique rétroactivement le barème de points de computeLatePenalty selon le préavis que
    -- l'Œil avait réellement donné (created_at de cette ligne vs missions.scheduled_at), jamais
    -- selon l'instant de la requalification elle-même. Voir POST
    -- /missions/assistance-requests/:id/requalify, routes/missions.js.
    ALTER TABLE mission_assistance_requests ADD COLUMN IF NOT EXISTS admin_requalified_at TIMESTAMPTZ;
    ALTER TABLE mission_assistance_requests ADD COLUMN IF NOT EXISTS admin_requalified_by TEXT REFERENCES users(id);

    -- ── PROMPT 2 (2026-08-17) — cascade cap, reprise H+30, litige cash découplé, détection
    -- d'abandon par photo, notes clients, strikes no-show client. Voir rapport de session.

    -- Plafonne la cascade de confirmation par lot à candidate_batch_max_waves lots successifs
    -- (setting, voir settingsDefaults.js) au lieu d'un tirage illimité tant que mission_interests
    -- n'est pas épuisé — voir advanceCandidateCascade, routes/missions.js. Remis à 0 à chaque
    -- nouveau cycle de libération authentique (transferred_from fraîchement posé) — jamais à
    -- l'intérieur d'advanceCandidateCascade elle-même, qui doit au contraire accumuler les
    -- tirages successifs du MÊME cycle pour que le plafond ait un sens.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS batch_wave_count INTEGER NOT NULL DEFAULT 0;

    -- Distingue un transfert H+30 (no-show, potentiellement de bonne foi — retard, embouteillage...)
    -- des autres origines de libération (URGENCE, suspension admin, blocage anti-fraude,
    -- confirmation de présence manquée, refus d'edit-request) qui posent toutes transferred_from
    -- mais ne doivent PAS permettre à l'Œil d'origine de "reprendre" la mission plus tard — seul
    -- le no-show H+30 le permet (POST /:id/resume-after-h30), si l'Œil se manifeste avant qu'un
    -- remplaçant soit confirmé. Flag explicite plutôt qu'une déduction depuis transfer_reason
    -- (texte libre, fragile à comparer) — même principe que transfer_no_penalty ci-dessus. Remis
    -- à false à chaque nouveau cycle de libération, comme batch_wave_count.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS transfer_h30_no_show BOOLEAN NOT NULL DEFAULT FALSE;

    -- Détection d'abandon sans GPS (mission active) : le système redemande une photo (sans
    -- visage) toutes les activity_photo_interval_minutes (setting) tant que la mission est
    -- 'active'. next_due_at est pointé vers l'avant à l'activation ET à chaque photo reçue (voir
    -- POST /:id/status et routes/media.js) ; le cron dédié (index.js) n'a donc qu'à comparer
    -- next_due_at à NOW(), jamais besoin de relire mission_media. alerted évite de renotifier
    -- client/admin à chaque tick tant qu'aucune photo n'est revenue depuis la première alerte.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS activity_photo_next_due_at TIMESTAMPTZ;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS activity_photo_alerted BOOLEAN NOT NULL DEFAULT FALSE;

    -- ── Litige "client absent" (cash) découplé : motif structuré + décision commission distincte ──
    -- dispute_reason='client_absent' : posé par l'admin AU MOMENT de PUT /admin/claims/
    -- :missionId/resolve (routes/users.js) — c'est la RATIFICATION admin qui fait foi, jamais le
    -- texte libre saisi par l'Œil ou le client. Seule cette valeur déclenche à la fois (a) le
    -- découplage commission ci-dessous et (b) l'éligibilité au strike no-show client
    -- (client_strikes, ci-dessous) — les deux restant deux actions indépendantes dans le code,
    -- jamais la même (exigence explicite de la session : un admin peut libérer la commission tout
    -- en posant quand même un strike, ou l'inverse).
    ALTER TABLE claims ADD COLUMN IF NOT EXISTS dispute_reason TEXT CHECK(dispute_reason IN ('client_absent'));
    -- Pour une mission cash avec dispute_reason='client_absent' ET decision='oeil' : la commission
    -- n'est PLUS débitée automatiquement dans la même transaction que la résolution (comportement
    -- historique conservé pour tout autre cas — payzone, ou cash sans ce motif). Elle reste en
    -- attente (commission_decision IS NULL) jusqu'à une décision admin explicite et séparée via
    -- POST /admin/claims/:missionId/commission.
    ALTER TABLE claims ADD COLUMN IF NOT EXISTS commission_decision TEXT CHECK(commission_decision IN ('debited','released'));
    ALTER TABLE claims ADD COLUMN IF NOT EXISTS commission_decided_by TEXT REFERENCES users(id);
    ALTER TABLE claims ADD COLUMN IF NOT EXISTS commission_decided_at TIMESTAMPTZ;

    -- Même découplage, pour la voie SILENCIEUSE (checkAssistanceRequestExpiry, routes/
    -- missions.js — client n'ayant jamais répondu sous 12h, donc aucun litige claims créé) :
    -- colonnes séparées plutôt que de forcer une ligne claims artificielle pour un cas qui n'a
    -- jamais été activement contesté par personne. Pour une mission cash, le statut se clôture
    -- toujours automatiquement (comme avant, évite un blocage éternel) mais la commission reste
    -- en attente jusqu'à POST /missions/assistance-requests/:id/commission (admin). Ne s'applique
    -- qu'à category='mission' — 'urgence' ne passe jamais par ce chemin (skipReliabilityPenalty,
    -- pas de commission en jeu à ce stade).
    ALTER TABLE mission_assistance_requests ADD COLUMN IF NOT EXISTS commission_decision TEXT CHECK(commission_decision IN ('debited','released'));
    ALTER TABLE mission_assistance_requests ADD COLUMN IF NOT EXISTS commission_decided_by TEXT REFERENCES users(id);
    ALTER TABLE mission_assistance_requests ADD COLUMN IF NOT EXISTS commission_decided_at TIMESTAMPTZ;

    -- Réattribution forcée par un admin (PROMPT 2 point 4, 2026-08-17) — POST /missions/:id/
    -- force-reassign insère une ligne category='urgence' comme si l'Œil l'avait lui-même
    -- déclarée (même parcours releaseMissionForReplacement), toujours requalifiable a posteriori
    -- via POST /missions/assistance-requests/:id/requalify (PROMPT 1 point 5, inchangée — voir
    -- toutefois sa garde anti-double-pénalité ajoutée 2026-09-12). triggered_by_admin_id (NULL
    -- pour une déclaration Œil normale) distingue les deux origines dans l'historique/l'écran
    -- admin, sans dupliquer le mécanisme de requalification pour un cas qui suit exactement les
    -- mêmes règles. Correctif 2026-09-12 (RAPPORT_PENALITES_FIABILITE.md) : skipReliabilityPenalty
    -- N'EST PLUS systématiquement true ici — passé conditionnellement selon exempt_penalty (champ
    -- explicite du body, jamais un défaut silencieux), voir le commentaire de la route. Avant ce
    -- correctif la pénalité -70 (transfer_during_no_replacement_penalty_points) était
    -- structurellement inatteignable par cette route (skip toujours true).
    ALTER TABLE mission_assistance_requests ADD COLUMN IF NOT EXISTS triggered_by_admin_id TEXT REFERENCES users(id);

    -- ── Strikes "client absent" (anti-fraude no-show client) ──────────────────────────────
    -- Un strike = un admin a résolu un litige d'assistance avec dispute_reason='client_absent' EN
    -- FAVEUR DE L'ŒIL (decision='oeil') — jamais depuis l'auto-validation silencieuse à 12h
    -- (checkAssistanceRequestExpiry, routes/missions.js), qui n'implique aucun jugement humain.
    -- Table d'audit dédiée (qui/quand/quelle mission) plutôt qu'un simple compteur : permet à
    -- l'onglet admin "Clients suspendus" d'afficher l'historique complet, pas seulement le total.
    CREATE TABLE IF NOT EXISTS client_strikes (
      id          SERIAL PRIMARY KEY,
      client_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mission_id  TEXT NOT NULL REFERENCES missions(id),
      reason      TEXT NOT NULL,
      created_by  TEXT REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_client_strikes_client ON client_strikes(client_id);
    -- Cache dénormalisé (même principe que oeil_profiles.rating_avg/rating_count) — évite un
    -- COUNT(*) sur client_strikes à chaque affichage de liste client. 1er strike (=1) :
    -- avertissement client uniquement. 2e strike (=2) : blocage automatique
    -- (users.is_active=false) + apparition dans l'onglet admin "Clients suspendus" — voir
    -- applyClientStrike, utils/clientStrikes.js.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS client_noshow_strikes INTEGER NOT NULL DEFAULT 0;

    -- ── Note des clients par les Œils (symétrique de ratings, ci-dessus) ───────────────────
    -- Un score par mission (UNIQUE mission_id, même contrainte que ratings), écrit par l'Œil
    -- après la mission — voir POST /missions/:id/rate-client. Visible à un autre Œil AVANT de
    -- candidater/accepter (moyenne+nombre, jamais le détail des commentaires d'autrui à ce stade)
    -- via les colonnes cache ci-dessous sur users, au même titre que oeil_profiles.rating_avg/
    -- rating_count pour la note existante client->Œil.
    CREATE TABLE IF NOT EXISTS client_ratings (
      id          SERIAL PRIMARY KEY,
      mission_id  TEXT UNIQUE NOT NULL REFERENCES missions(id),
      oeil_id     TEXT NOT NULL REFERENCES users(id),
      client_id   TEXT NOT NULL REFERENCES users(id),
      score       INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
      comment     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS client_rating_avg NUMERIC(3,1);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS client_rating_count INTEGER NOT NULL DEFAULT 0;

    -- ── PROMPT 5 (2026-08-18) — Notifications et bugs techniques confirmés ────────────────
    -- Rappel intermédiaire client (H+6 de la fenêtre de validation 12h, voir jobs/
    -- autoValidateMissions.js:runValidationReminders) — garde anti-doublon, un seul rappel
    -- par mission avant l'auto-validation silencieuse.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS validation_reminder_sent_at TIMESTAMPTZ;

    -- Relance des candidatures non choisies par le client (voir cron dédié, index.js) : compteur
    -- + horodatage de la dernière relance WhatsApp, pour calculer la prochaine échéance
    -- (candidature_relance_first_after_minutes puis candidature_relance_interval_minutes).
    -- candidature_admin_alert_sent_at bascule la relance en alerte admin ("Missions proches sans
    -- validation") une fois la mission trop proche de scheduled_at — posé une seule fois, sert
    -- aussi de filtre à la liste admin (GET /missions/admin/missions-proches-validation).
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS candidature_relance_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS candidature_relance_last_sent_at TIMESTAMPTZ;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS candidature_admin_alert_sent_at TIMESTAMPTZ;

    -- Relance par email des notifications WhatsApp à délai court restées non lues — cascade
    -- candidat (mission_interests, ~10min) et confirmation de présence H-45 (missions). Garde
    -- anti-doublon par cycle de sollicitation ; presence_confirmation_h45_email_sent_at est remis
    -- à NULL à chaque nouvelle ouverture du point de contrôle H-45 (voir index.js, même UPDATE que
    -- presence_confirmed_at) pour rester utilisable si la mission repasse par ce palier.
    ALTER TABLE mission_interests ADD COLUMN IF NOT EXISTS email_fallback_sent_at TIMESTAMPTZ;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS presence_confirmation_h45_email_sent_at TIMESTAMPTZ;

    -- ── PROMPT 6 (2026-08-18) — Compte client désactivé avec mission active ───────────────
    -- Horodatage de la décision de l'Œil (honorer/annuler) face à un client désactivé en cours
    -- de mission. État "en attente de décision" entièrement dérivé (pas de statut dédié) : voir
    -- GET /missions/pending-client-disabled — une mission n'y apparaît que si le client est
    -- is_active=false ET ce champ est NULL, donc redevient invisible automatiquement si le client
    -- est réactivé, sans rien à nettoyer ici. Posé aussi bien sur "honorer" (empêche de re-
    -- proposer le choix) que sur "annuler" (déjà exclue par son statut 'cancelled', posé quand
    -- même pour garder un historique complet). Voir handleClientDisabled, routes/missions.js.
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS client_disabled_ack_at TIMESTAMPTZ;

    -- CONSTAT 12 (audit-360, 2026-08-21) — le rappel H+6 client (validation_reminder_sent_at
    -- ci-dessus) ne couvrait que status='completed' ; une mission gelée en sous_reclamation par
    -- une demande d'assistance catégorie 'mission' (voir checkAssistanceRequestExpiry,
    -- routes/missions.js) attend elle aussi une réponse du client dans la même fenêtre de
    -- client_validation_hours, sans jamais recevoir de rappel intermédiaire. Même garde
    -- anti-doublon, même principe que validation_reminder_sent_at (jobs/autoValidateMissions.js:
    -- runAssistanceReminders).
    ALTER TABLE mission_assistance_requests ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

    -- ── Historique des modifications de réglages (chantier "historique des réglages",
    -- 2026-09-04) — la refonte de l'écran Paramètres (RAPPORT_CHANTIER_REFONTE_PARAMETRES,
    -- 2026-09-03) avait retiré le badge "dernière modification" par champ faute d'historique en
    -- base ; cette table le fournit. Une ligne par CLÉ effectivement modifiée (pas par appel PUT
    -- /admin/settings, qui peut toucher plusieurs clés à la fois) — voir routes/users.js. Aucun
    -- historique rétroactif possible : ne couvre que les changements survenus après ce déploiement.
    CREATE TABLE IF NOT EXISTS settings_history (
      id          SERIAL PRIMARY KEY,
      setting_key TEXT NOT NULL,
      old_value   TEXT,
      new_value   TEXT NOT NULL,
      changed_by  TEXT NOT NULL REFERENCES users(id),
      changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_settings_history_key ON settings_history(setting_key);
    CREATE INDEX IF NOT EXISTS idx_settings_history_changed_at ON settings_history(changed_at DESC);

    -- ── Recours d'un compte bloqué (is_active=false) — chantier L4, 2026-09-09 ─────────────
    -- Avant : un compte is_active=false (blocage anti-fraude, POST /anti-fraud/block ; ou
    -- désactivation client via PUT /users/admin/:id/toggle-active / 2e strike no-show,
    -- utils/clientStrikes.js) était en verrou TOTAL — login 403 sans token, 401 sur toutes les
    -- routes, aucun canal in-app pour comprendre ou contester (le seul canal théorique,
    -- WhatsApp, est cassé — G5). Ce chantier ouvre un accès restreint calqué sur le patron
    -- déjà en place pour is_suspended (middleware/auth.js isSuspendedOeilAllowed +
    -- CompteSuspendu.jsx + POST /reliability/review-request).
    --
    -- deactivation_context : POURQUOI le compte est is_active=false — discrimine le niveau de
    -- recours accordé (voir isDeactivatedAccountAllowed, middleware/auth.js) :
    --   'fraud_block'     → blocage anti-fraude : canal MINIMAL (voir le motif + UNE
    --                       contestation jamais rouvrable ; pas de fil de support).
    --   'admin_toggle'    → désactivation admin générique (toggle-active branche non-Œil).
    --   'noshow_strikes'  → 2e strike no-show client (clientStrikes.js).
    --   'admin_toggle' / 'noshow_strikes' → canal COMPLET (contestation re-soumissible après
    --                       décision + fil de tickets), aligné sur is_suspended.
    -- NULL = compte actif, OU compte bloqué AVANT ce déploiement (aucun rétro-remplissage) —
    -- traité comme le cas le plus restrictif (canal minimal). Posé par les 3 sites d'écriture
    -- de is_active=false, remis à NULL à toute réactivation (decide 'approved',
    -- /admin/clients/:id/unblock, toggle-active réactivation).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivation_context TEXT;

    -- account_block_appeals : structure calquée à l'identique sur reliability_review_requests
    -- (schema.js:513) — même colonnes, mêmes sémantiques (status pending/approved/rejected,
    -- admin_response, reviewed_by/reviewed_at). Seule différence : user_id (tout rôle) au lieu
    -- de oeil_id, car un blocage anti-fraude peut viser un client comme un Œil. Re-soumission :
    -- gérée en amont dans POST /api/block-appeals (une seule 'pending' à la fois pour le canal
    -- complet ; une seule ligne TOUTES statuts confondus pour le canal minimal 'fraud_block').
    CREATE TABLE IF NOT EXISTS account_block_appeals (
      id             SERIAL PRIMARY KEY,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message        TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      admin_response TEXT,
      reviewed_by    TEXT REFERENCES users(id),
      reviewed_at    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_account_block_appeals_user ON account_block_appeals(user_id);
    CREATE INDEX IF NOT EXISTS idx_account_block_appeals_status ON account_block_appeals(status);

    -- ═══ Index de performance — audit BDD 2026-09-06 §2 (I1 à I9) ════════════════════════════
    -- Source : rapport-audit-base-de-donnees-contraintes-index-transactions-2026-09-06, §2
    -- (Seq Scan confirmés par EXPLAIN ANALYZE). Correctif : rapport-groupe2-index-performance-
    -- 2026-09-06. Lancé APRÈS le Groupe 1 (contraintes C1-C5/C20, commit 63a79e6, même fichier).
    --
    -- Ajout PUREMENT ADDITIF. Chaque CREATE INDEX IF NOT EXISTS est idempotent (les redémarrages
    -- suivants sautent la ligne) et NE CHANGE PAS la sémantique d'une seule requête — seul le
    -- plan change. Aucun de ces 14 index ne double ni n'entre en conflit avec un index existant
    -- (vérifié nom par nom contre les ~30 CREATE INDEX ci-dessus + la liste « déjà bien placés »
    -- du §2). Pas de CONCURRENTLY (interdit dans le bloc implicite de initDb, et inutile : tables
    -- pré-lancement de quelques centaines de lignes, création en millisecondes au boot) — même
    -- convention que tous les index de ce fichier. Preuve fraîche EXPLAIN ANALYZE avant/après,
    -- base locale (volume réel) + jeu synthétique 100k lignes, dans le rapport : à 100k lignes,
    -- Seq Scan → Index/Bitmap Scan pour les 14, gain ×20 à ×475. À volume actuel (~200-500
    -- lignes) le planificateur en adopte déjà une partie ; les autres restent en Seq Scan tant
    -- que la table est petite (comportement correct — le §2 le dit : « volumétrie faible → cer-
    -- tains plans restent rapides aujourd'hui »), l'index prend le relais automatiquement à la
    -- montée en charge. Les tables visées croissent toutes de façon monotone avec l'activité :
    -- une ligne d'historique par transition, de ledger par mouvement, d'événement par pénalité.

    -- I1-I3 (HAUT) — colonne FK sans index, Seq Scan confirmé, chemin chaud.
    -- I1 : lecture à CHAQUE ouverture de fiche mission (GET /:id/history, missions.js:687) ;
    --      écriture 2-6×/mission (logStatus). Table = somme de toutes les transitions.
    CREATE INDEX IF NOT EXISTS idx_mission_status_history_mission_id ON mission_status_history(mission_id);
    -- I2 : historique wallet admin (users.js:370), liste des virements (users.js:2423), dernier
    --      mouvement (users.js:2494), reprise pénalité H+30 (missions.js:3305) — tous en
    --      WHERE user_id=$1. NB : la requête que le §2 cite pour I2 (walletReconciliation.js,
    --      « SUM par type WHERE user_id ») n'existe plus telle quelle — le job fait désormais un
    --      balayage complet GROUP BY user_id SANS WHERE, que cet index n'accélère pas et ne doit
    --      pas accélérer (vérifié : Seq Scan conservé après création). L'index reste justifié par
    --      les 4 appelants ci-dessus.
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON wallet_transactions(user_id);
    -- I3 : computeReliabilityScore (reliabilityScore.js:71 — requête principale + sous-requête
    --      corrélée sur la même table), checkAndUpdateSuspension, tout affichage de score
    --      (profil Œil, écrans admin fiabilité, reliabilityRoutes.js, users.js:419/936).
    CREATE INDEX IF NOT EXISTS idx_reliability_events_oeil_id ON reliability_events(oeil_id);

    -- I4-I7 (MOYEN) — Seq Scan confirmé, FK non couverte, fréquence moyenne.
    -- I4 : détail financier mission / idempotence remboursement (missions.js:3305). Couvre aussi
    --      la validation de la FK wallet_transactions_mission_id_fkey (DELETE mission).
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_mission_id ON wallet_transactions(mission_id);
    -- I5 : GET /oeil/availability (users.js:179) + le DELETE global de PUT /oeil/availability
    --      (users.js:187), tous deux WHERE user_id=$1.
    CREATE INDEX IF NOT EXISTS idx_oeil_availability_user_id ON oeil_availability(user_id);
    -- I6 : clôture mission — COUNT photos de l'Œil (missions.js:1886, reports.js:43) ; liste
    --      média (missions.js:1656) ; media_count (missions.js:849, reliabilityRoutes.js:133).
    CREATE INDEX IF NOT EXISTS idx_mission_media_mission_id ON mission_media(mission_id);
    -- I7 : plafond max_uses_per_user à chaque rédemption promo (missions.js:298, promo.js:25),
    --      exactement WHERE promo_id=$1 AND user_id=$2. NON unique : max_uses_per_user peut
    --      valoir > 1 (un même couple (promo, user) a alors plusieurs lignes légitimes).
    CREATE INDEX IF NOT EXISTS idx_promo_uses_promo_id_user_id ON promo_uses(promo_id, user_id);

    -- I8 (MOYEN) — colonnes de deadline balayées par les crons toutes les 2-5 min. Index
    -- PARTIELS (WHERE col IS NOT NULL) : à un instant donné une poignée de missions seulement
    -- portent une de ces échéances → index de ~2 pages, coût d'écriture quasi nul sur les 99,9 %
    -- de lignes où la colonne est NULL. Un index par colonne, prédicat calé sur l'usage réel
    -- (toujours « col IS NOT NULL AND col <= NOW() »). idx_missions_status n'aide pas ces
    -- requêtes (status='pending' = quasi tout le backlog).
    CREATE INDEX IF NOT EXISTS idx_missions_batch_tiebreak_ends_at ON missions(batch_tiebreak_ends_at) WHERE batch_tiebreak_ends_at IS NOT NULL;                             -- index.js:1306, cron */2
    CREATE INDEX IF NOT EXISTS idx_missions_candidate_window_ends_at ON missions(candidate_window_ends_at) WHERE candidate_window_ends_at IS NOT NULL;                       -- index.js:1370, cron */2
    CREATE INDEX IF NOT EXISTS idx_missions_urgent_whatsapp_next_wave_at ON missions(urgent_whatsapp_next_wave_at) WHERE urgent_whatsapp_next_wave_at IS NOT NULL;           -- index.js:1405, cron 1-59/5
    CREATE INDEX IF NOT EXISTS idx_missions_presence_confirmation_deadline_at ON missions(presence_confirmation_deadline_at) WHERE presence_confirmation_deadline_at IS NOT NULL; -- missions.js:3720, cron */5
    CREATE INDEX IF NOT EXISTS idx_missions_transfer_deadline ON missions(transfer_deadline) WHERE transfer_deadline IS NOT NULL;                                             -- missions.js:3542, cron */5
    CREATE INDEX IF NOT EXISTS idx_missions_activity_photo_next_due_at ON missions(activity_photo_next_due_at) WHERE activity_photo_next_due_at IS NOT NULL;                   -- missions.js:3833, cron */5
    -- I8g stale_notified_at — VOLONTAIREMENT PAS D'INDEX. Le §2 le liste avec les 6 ci-dessus,
    -- mais son unique consommateur (cron missions périmées, index.js:1541) filtre « stale_
    -- notified_at IS NULL » — sentinelle « pas encore notifié », même motif que candidature_
    -- whatsapp_sent_at. C'est l'exact opposé d'un index partiel WHERE … IS NOT NULL, qui
    -- indexerait précisément les lignes que la requête EXCLUT. Un partiel WHERE … IS NULL serait
    -- lui non sélectif (quasi tout le backlog pending est à NULL). Polarité inversée dans le
    -- rapport source : signalée, non implémentée (aucun consommateur ne lit cette colonne en
    -- IS NOT NULL).

    -- I9 (MOYEN) — filtre fonctionnel DATE(scheduled_at AT TIME ZONE 'Africa/Casablanca') des
    -- crons J-1 : présence Œil 20h (index.js:520), rappel client 20h (index.js:580), récap admin
    -- 22h (index.js:652) — les 3 prédicats sont mot pour mot « DATE(m.scheduled_at AT TIME ZONE
    -- 'Africa/Casablanca') = $1 ». L'expression de l'index est donc écrite à l'identique.
    -- Index d'expression VIABLE (le prompt demandait de le vérifier avant pose) : scheduled_at
    -- est TIMESTAMPTZ → « AT TIME ZONE 'Africa/Casablanca' » se lie à timezone(text, timestamptz),
    -- IMMUTABLE depuis PG 8.0 (provolatile='i' vérifié sur le PG 18.2 local) — pas de cast STABLE
    -- dans la chaîne, contrairement à DATE(timestamptz) direct. CREATE INDEX accepté, planifi-
    -- cateur confirmé sur base réelle ET synthétique (Index/Bitmap Scan, 117 ms → 1,5 ms à 100k).
    CREATE INDEX IF NOT EXISTS idx_missions_scheduled_at_casablanca_date ON missions ((DATE(scheduled_at AT TIME ZONE 'Africa/Casablanca')));

    -- ═══ Index de performance — audit Performance 2026-09-07 (P1 GET /missions, P4 dashboards) ══
    -- Source : rapport-audit-performance-2026-09-07, §2.3 (P1) et §5 (P4). Correctif : rapport-
    -- prompt-A-performance-backend-2026-09-07. Lancé APRÈS Prompt C (F1/F2 TOCTOU, commit 8ec8451,
    -- routes/missions.js). Même méthodologie que le Groupe 2 (06/09) : EXPLAIN ANALYZE avant/après
    -- sur jeu synthétique 100k lignes (mêmes volumes que le rapport Perf §1), adoption planificateur
    -- confirmée requête par requête. AJOUT PUREMENT ADDITIF — CREATE INDEX IF NOT EXISTS idempotent,
    -- aucune requête ne change de sémantique, seul le plan change. 8 noms vérifiés contre les ~48
    -- index déjà déclarés ci-dessus (0 doublon, 0 recouvrement). Pas de CONCURRENTLY (interdit dans
    -- le bloc implicite de initDb, inutile au volume pré-lancement — même convention que tout le
    -- fichier ; sur une table déjà volumineuse, un CREATE INDEX CONCURRENTLY manuel hors-bande rend
    -- la ligne no-op grâce au IF NOT EXISTS).

    -- ── P4 — colonnes date filtrées par BETWEEN dans les dashboards admin (routes/users.js) ──
    -- dashboard/oeils : délai moyen d'assignation (missions.created_at, users.js:868), classement
    -- (missions.completed_at, users.js:911), trop d'annulations (missions.updated_at, users.js:924),
    -- taux d'acceptation (mission_interests.created_at, users.js:863), retards fréquents
    -- (reliability_events.created_at, users.js:938). Gain fonction de l'étroitesse de la plage :
    -- le filtre par défaut du frontend est « Ce mois » (components/dashboard/DateRangeFilter.jsx,
    -- getPresetRange('month') ; presets = aujourd'hui/hier/semaine/mois/personnalisé — aucun preset
    -- « année ») → au plus ~31 jours, souvent bien moins → l'index est adopté et fait chuter le
    -- temps (mesuré 100k, plage « ce mois » : P4.2 130→4,6 ms ; P4.3 165→17 ms ; P4.5 66→3,3 ms).
    -- Sur une plage ≈ 1 an (≈ toute la table) le planificateur garde un Seq Scan : c'est correct,
    -- l'index n'est simplement pas rentable à ce moment-là (aucune régression mesurée sur ce cas).
    -- Index simples (pas de partiel) : created_at/updated_at sont NOT NULL ; completed_at est
    -- nullable mais un partiel WHERE … IS NOT NULL n'économise ~rien (58 % des missions sont
    -- complétées) et dévierait de la forme « colonne date simple » du rapport. idx_missions_
    -- created_at sert AUSSI le tri par défaut created_desc/created_asc de GET /api/missions.
    -- (reliability_events.reason ILIKE '%heure%' de P4.5 : NON transformé en flag — voir le
    --  rapport §P4 ; l'index date seul suffit, une refonte de la taxonomie reason est un chantier
    --  dédié avec migration de données.)
    CREATE INDEX IF NOT EXISTS idx_missions_created_at           ON missions(created_at);
    CREATE INDEX IF NOT EXISTS idx_missions_completed_at         ON missions(completed_at);
    CREATE INDEX IF NOT EXISTS idx_missions_updated_at           ON missions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_mission_interests_created_at  ON mission_interests(created_at);
    CREATE INDEX IF NOT EXISTS idx_reliability_events_created_at ON reliability_events(created_at);

    -- ── P1 (c) — colonnes de tri de GET /api/missions sans index (routes/missions.js:774-791) ──
    -- ORDER BY réellement proposé par l'UI : admin/Missions.jsx (sortBy ∈ title|client|oeil|price|
    -- status|scheduled|deadline × asc|desc) ; oeil/Missions.jsx onglet « disponibles » + oeil/
    -- Dashboard.jsx : sort=scheduled_asc fixe. Déjà couverts : created_at (idx_missions_created_at
    -- ci-dessus), status (idx_missions_status). Ajout de price, scheduled_at, title — adoption
    -- vérifiée EXPLAIN (admin, LIMIT 20, sans WHERE) : Index Scan → Limit, ~1-3 ms contre 500-700 ms
    -- de Seq Scan+Sort avant (G admin par défaut 580→5 ms ; L tri titre 714→8 ms).
    --   • scheduled_at : btree = ASC NULLS LAST → sert scheduled_asc directement (2,6 ms). Le cas
    --     scheduled_desc (DESC NULLS LAST) NE peut pas utiliser ce btree en parcours arrière
    --     (NULLS FIRST) → reste un top-N heapsort (~386 ms, LIMIT 20, admin, clic rare) : résiduel
    --     accepté, PAS de 2ᵉ index miroir DESC pour un tri de confort admin peu fréquent.
    --   • price : sert price_asc ET price_desc (Index Scan / Index Scan Backward, ~1,5 ms).
    --   • title : cap API 200 caractères (missions.js:1003) ≪ limite btree. Sert title_asc/desc.
    --   • deadline_asc : l'onglet admin « priorité » envoie toujours status=pending → le plan
    --     utilise idx_missions_status puis top-N (~76 ms, inchangé) ; pas d'index dédié.
    --   • client_*/oeil_* : tri sur users joint — un index users(first_name,last_name) n'éviterait
    --     pas le Sort du plan dominant (admin non filtré = jointure 100k avant tri). Non ajouté.
    CREATE INDEX IF NOT EXISTS idx_missions_price        ON missions(price);
    CREATE INDEX IF NOT EXISTS idx_missions_scheduled_at ON missions(scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_missions_title        ON missions(title);

    -- ── P1 (d) — recherche texte libre de GET /api/missions (admin ?search=) : PAS D'INDEX ──────
    -- ARRÊT SIGNALÉ (règle commune : ne pas forcer un correctif qui ne tient pas). Le WHERE de
    -- recherche (missions.js:840-850) est un OR sur 4 cibles réparties sur 3 tables :
    --   m.id::text ILIKE $ OR m.title ILIKE $ OR (c.first_name||' '||c.last_name) ILIKE $
    --   OR (o.first_name||' '||o.last_name) ILIKE $        (c, o = users joints)
    -- PostgreSQL ne peut PAS faire de BitmapOr d'index quand les disjonctions portent sur des
    -- relations différentes → l'évaluation se fait forcément en filtre post-jointure, donc Seq Scan
    -- de la jointure, quel que soit l'index posé. Vérifié EXPLAIN : des index GIN pg_trgm sur
    -- missions(title), missions(id) et users((first_name||' '||last_name)) NE SONT JAMAIS retenus
    -- pour cette requête (0 changement de plan, ni sur terme fréquent ni sur terme rare). Les
    -- accélérer exigerait soit une réécriture de la LOGIQUE de recherche (décomposer le OR
    -- inter-tables en sous-requêtes/UNION par table — hors périmètre : « sans changer la logique »),
    -- soit une dénormalisation de client_name/oeil_name sur missions (schéma + write-path —
    -- chantier dédié). Mitigation indirecte réellement obtenue : idx_missions_price ci-dessus
    -- ramène le pire cas documenté (?search=X&sort=price_desc) de ~760 ms à ~5 ms QUAND le terme
    -- ramène assez de lignes (Index Scan Backward price + arrêt anticipé au LIMIT) ; un terme rare
    -- ou sans résultat reste un Seq Scan ~300-400 ms. Détail et options dans le rapport §P1(d).

    -- ═══ Canal de notification push — Web Push / VAPID — chantier push, 2026-09-09 ═══════════
    -- Source : rapport-chantier-audit-notifications-matrice-2026-09-08.md §6.1. Vérifié avant
    -- pose : aucune structure device/subscription/push/token préexistante (grep schema.js).
    -- AJOUT PUREMENT ADDITIF — 2 tables neuves + 3 index, CREATE ... IF NOT EXISTS idempotent,
    -- aucune requête existante ne change. Ces tables sont un ANNUAIRE + un JOURNAL : aucune
    -- logique d'escalade n'y vit (elle reste dans utils/notify.js, les crons, settings).
    --
    -- push_subscriptions : un abonnement = un couple (utilisateur, appareil/navigateur).
    -- provider / platform par défaut 'webpush' / 'web' — colonnes présentes pour un éventuel
    -- FCM/APNs natif plus tard, sans migration. keys = {p256dh, auth} du PushSubscription du
    -- navigateur. disabled_at posé (pas de DELETE) quand le provider renvoie 404/410 (endpoint
    -- révoqué) — même philosophie que whatsapp_send_failures.resolved_at : visibilité.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id              BIGSERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform        TEXT NOT NULL DEFAULT 'web',
      provider        TEXT NOT NULL DEFAULT 'webpush',
      endpoint        TEXT NOT NULL,
      keys            JSONB,
      user_agent      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_push_at    TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      last_failure_at TIMESTAMPTZ,
      failure_count   INT NOT NULL DEFAULT 0,
      disabled_at     TIMESTAMPTZ,
      UNIQUE (user_id, endpoint)
    );
    -- Lookup chaud de services/push.js sendWebPush (par user, abonnements vivants seulement).
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_active ON push_subscriptions(user_id) WHERE disabled_at IS NULL;

    -- push_send_log : journal d'envoi (succès ET échec), miroir de whatsapp_send_failures mais
    -- symétrique. C'est ici que naît le seul « délivré » réaliste : status='sent' = « le provider
    -- a accepté le POST chiffré » (équivalent response.ok Wasel/Resend — aucun accusé de
    -- livraison/lecture réel n'existe en Web Push standard). status ∈
    -- 'sent' | 'provider_error' | 'expired_endpoint' | 'skipped_no_sub'.
    CREATE TABLE IF NOT EXISTS push_send_log (
      id              BIGSERIAL PRIMARY KEY,
      subscription_id BIGINT REFERENCES push_subscriptions(id) ON DELETE SET NULL,
      user_id         TEXT NOT NULL,
      notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
      event_key       TEXT,
      provider        TEXT,
      status          TEXT NOT NULL,
      provider_status INTEGER,
      error_message   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Requête de santé (checkPushHealth) : WHERE status='provider_error' AND created_at > NOW()-1h.
    CREATE INDEX IF NOT EXISTS idx_push_send_log_status_created ON push_send_log(status, created_at);
    -- Analytics par type d'événement / lien vers la ligne in-app source.
    CREATE INDEX IF NOT EXISTS idx_push_send_log_notification ON push_send_log(notification_id) WHERE notification_id IS NOT NULL;

    -- ═══ Planchers tarifaires par sous-catégorie — chantier « planchers éditables », 2026-09-10 ═══
    -- Remplace la table en dur SUBCATEGORY_MIN_PRICES (constants/missionCategories.js, chantier D1)
    -- ET son jumeau MIN_PRICES côté frontend (NewMissionModal.jsx), qui étaient maintenus synchro
    -- à la main. Source de vérité UNIQUE désormais : cette table. Lue en runtime via
    -- utils/subcategoryMinPrices.js (cache 60 s + invalidation à l'écriture), éditée depuis
    -- Paramètres › 💰 Tarification (PUT /api/users/admin/subcategory-min-prices).
    --
    -- subcategory = clé nue ('Consulat étranger', pas 'Consulats et visas — Consulat étranger') ;
    -- OU une des 4 sentinelles de défaut par type ('_immobilier' / '_file_attente' / '_audit' /
    -- '_personnalisee') appliquées quand la sous-catégorie choisie n'a pas de plancher nommé.
    -- Aucune vraie sous-catégorie ne commence par '_' → pas de collision. Voir
    -- config/subcategoryMinPricesSeed.js pour le détail des 49 valeurs initiales et l'historique.
    --
    -- Seed idempotent (ON CONFLICT DO NOTHING) : les 49 valeurs = COPIE EXACTE des planchers D1
    -- déjà en production. Zéro changement de comportement au déploiement. Sur une base déjà
    -- initialisée, l'admin peut avoir personnalisé une valeur → jamais réécrasée.
    CREATE TABLE IF NOT EXISTS subcategory_min_prices (
      subcategory TEXT PRIMARY KEY,
      category    TEXT NOT NULL,
      min_price   NUMERIC NOT NULL CHECK (min_price > 0)
    );
    INSERT INTO subcategory_min_prices (subcategory, category, min_price) VALUES
      ${SUBCATEGORY_MIN_PRICES_SEED.map(r => `('${r.subcategory.replace(/'/g, "''")}', '${r.category}', ${r.min_price})`).join(',\n      ')}
    ON CONFLICT (subcategory) DO NOTHING;
  `);
  console.log('✅ PostgreSQL schema ready');
}
module.exports = { getDb, initDb, checkDbConnection };
