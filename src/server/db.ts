import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, title TEXT NOT NULL, product_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','live','ended')),
      stream_secret TEXT NOT NULL, created_at INTEGER NOT NULL, live_started_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), text TEXT NOT NULL,
      evidence TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN(0,1))
    );
    CREATE TABLE IF NOT EXISTS visits (
      room_id TEXT NOT NULL REFERENCES rooms(id), viewer_id TEXT NOT NULL,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, watch_seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(room_id,viewer_id)
    );
    CREATE TABLE IF NOT EXISTS presence (
      room_id TEXT NOT NULL REFERENCES rooms(id), viewer_id TEXT NOT NULL, minute INTEGER NOT NULL,
      PRIMARY KEY(room_id,viewer_id,minute)
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), total_cents INTEGER NOT NULL CHECK(total_cents>0),
      count INTEGER NOT NULL CHECK(count>0), remaining_cents INTEGER NOT NULL CHECK(remaining_cents>=0),
      remaining_count INTEGER NOT NULL CHECK(remaining_count>=0), min_watch_seconds INTEGER NOT NULL,
      opens_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed'))
    );
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), viewer_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0), status TEXT NOT NULL CHECK(status IN ('reserved','simulated')),
      created_at INTEGER NOT NULL, UNIQUE(campaign_id,viewer_id)
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), claim_id TEXT REFERENCES claims(id),
      debit TEXT NOT NULL, credit TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
      created_at INTEGER NOT NULL, UNIQUE(claim_id,debit,credit)
    );
    CREATE TABLE IF NOT EXISTS payout_jobs (
      id TEXT PRIMARY KEY, claim_id TEXT NOT NULL UNIQUE REFERENCES claims(id), state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), viewer_id TEXT NOT NULL,
      text TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rooms_merchant ON rooms(merchant_id);
    CREATE INDEX IF NOT EXISTS campaigns_room ON campaigns(room_id);
    CREATE INDEX IF NOT EXISTS visits_room_seen ON visits(room_id,last_seen);
    CREATE INDEX IF NOT EXISTS questions_room ON questions(room_id);
    INSERT OR IGNORE INTO schema_migrations VALUES(1,unixepoch());
  `);
  const version = Number(
    db.prepare("SELECT max(version) AS version FROM schema_migrations").get()
      ?.version || 1,
  );
  if (version < 2)
    transaction(db, () => {
      db.exec(`
      ALTER TABLE visits ADD COLUMN watch_millis INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE visits ADD COLUMN active INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE visits ADD COLUMN session_watch_millis INTEGER NOT NULL DEFAULT 0;
      UPDATE visits SET watch_millis=watch_seconds*1000;
      CREATE TABLE revoked_sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES(2,unixepoch());
    `);
    });
  if (version < 3)
    transaction(db, () => {
      db.exec(`
        CREATE TABLE material_imports (
          id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
          source_name TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('csv','json')),
          content_hash TEXT NOT NULL, request_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          created_at INTEGER NOT NULL, imported_count INTEGER NOT NULL, skipped_count INTEGER NOT NULL,
          fact_ids_json TEXT NOT NULL, UNIQUE(room_id,idempotency_key)
        );
        CREATE INDEX material_imports_room ON material_imports(room_id,created_at);
        INSERT INTO schema_migrations VALUES(3,unixepoch());
      `);
    });
  if (version < 4)
    transaction(db, () => {
      db.exec(`
        CREATE TABLE content_products (
          id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, name TEXT NOT NULL,
          sku TEXT NOT NULL, category TEXT NOT NULL, latest_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(merchant_id,sku)
        );
        CREATE TABLE content_product_versions (
          product_id TEXT NOT NULL REFERENCES content_products(id), version INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(product_id,version)
        );
        CREATE TABLE content_plans (
          id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES content_products(id),
          name TEXT NOT NULL, audience TEXT NOT NULL, total_days INTEGER NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE content_courses (
          id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES content_plans(id),
          title TEXT NOT NULL, day_index INTEGER NOT NULL, objective TEXT NOT NULL,
          duration_minutes INTEGER NOT NULL, schedule_label TEXT NOT NULL, presenter_name TEXT NOT NULL,
          latest_script_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        );
        CREATE TABLE content_script_versions (
          course_id TEXT NOT NULL REFERENCES content_courses(id), version INTEGER NOT NULL,
          product_id TEXT NOT NULL, product_version INTEGER NOT NULL, product_snapshot_json TEXT NOT NULL,
          paragraphs_json TEXT NOT NULL, change_note TEXT NOT NULL, check_json TEXT NOT NULL,
          created_at INTEGER NOT NULL, PRIMARY KEY(course_id,version),
          FOREIGN KEY(product_id,product_version) REFERENCES content_product_versions(product_id,version)
        );
        CREATE TABLE content_script_confirmations (
          course_id TEXT NOT NULL, script_version INTEGER NOT NULL, confirmed_at INTEGER NOT NULL,
          confirmed_by TEXT NOT NULL, note TEXT NOT NULL, PRIMARY KEY(course_id,script_version),
          FOREIGN KEY(course_id,script_version) REFERENCES content_script_versions(course_id,version)
        );
        CREATE TABLE content_room_bindings (
          room_id TEXT PRIMARY KEY REFERENCES rooms(id), course_id TEXT NOT NULL,
          script_version INTEGER NOT NULL, bound_at INTEGER NOT NULL,
          FOREIGN KEY(course_id,script_version) REFERENCES content_script_versions(course_id,version)
        );
        CREATE INDEX content_products_merchant ON content_products(merchant_id,updated_at);
        CREATE INDEX content_plans_product ON content_plans(product_id,created_at);
        CREATE INDEX content_courses_plan ON content_courses(plan_id,day_index);
        INSERT INTO schema_migrations VALUES(4,unixepoch());
      `);
      for (const table of [
        "content_product_versions",
        "content_script_versions",
        "content_script_confirmations",
      ])
        db.exec(`
          CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table}
            BEGIN SELECT RAISE(ABORT,'Content versions and confirmations are immutable'); END;
          CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table}
            BEGIN SELECT RAISE(ABORT,'Content versions and confirmations are immutable'); END;
        `);
    });
  if (version < 5)
    transaction(db, () => {
      db.exec(`
        CREATE TABLE content_binding_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_id TEXT NOT NULL REFERENCES rooms(id), course_id TEXT NOT NULL,
          script_version INTEGER NOT NULL, bound_at INTEGER NOT NULL,
          actor_id TEXT, source TEXT NOT NULL CHECK(source IN ('binding','legacy_snapshot')),
          room_title TEXT NOT NULL, course_title TEXT NOT NULL, product_name TEXT NOT NULL,
          FOREIGN KEY(course_id,script_version) REFERENCES content_script_versions(course_id,version)
        );
        CREATE INDEX content_binding_history_room ON content_binding_history(room_id,id DESC);
        INSERT INTO content_binding_history(room_id,course_id,script_version,bound_at,actor_id,source,room_title,course_title,product_name)
          SELECT b.room_id,b.course_id,b.script_version,b.bound_at,NULL,'legacy_snapshot',r.title,c.title,
            json_extract(s.product_snapshot_json,'$.name')
          FROM content_room_bindings b JOIN rooms r ON r.id=b.room_id
            JOIN content_courses c ON c.id=b.course_id
            JOIN content_script_versions s ON s.course_id=b.course_id AND s.version=b.script_version;
        CREATE TRIGGER content_binding_history_immutable_update BEFORE UPDATE ON content_binding_history
          BEGIN SELECT RAISE(ABORT,'Binding history is immutable'); END;
        CREATE TRIGGER content_binding_history_immutable_delete BEFORE DELETE ON content_binding_history
          BEGIN SELECT RAISE(ABORT,'Binding history is immutable'); END;
        INSERT INTO schema_migrations VALUES(5,unixepoch());
      `);
    });
  if (version < 6)
    transaction(db, () => {
      db.exec(`
      CREATE TABLE content_script_authors(course_id TEXT NOT NULL,script_version INTEGER NOT NULL,actor_id TEXT NOT NULL,
        PRIMARY KEY(course_id,script_version),FOREIGN KEY(course_id,script_version) REFERENCES content_script_versions(course_id,version));
      CREATE TABLE content_review_requests(course_id TEXT NOT NULL,script_version INTEGER NOT NULL,submitted_by TEXT NOT NULL,submitted_at INTEGER NOT NULL,note TEXT NOT NULL,
        PRIMARY KEY(course_id,script_version),FOREIGN KEY(course_id,script_version) REFERENCES content_script_versions(course_id,version));
      CREATE TABLE content_review_decisions(course_id TEXT NOT NULL,script_version INTEGER NOT NULL,reviewer_id TEXT NOT NULL,reviewed_at INTEGER NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('approved','changes_requested')),note TEXT NOT NULL,
        PRIMARY KEY(course_id,script_version),FOREIGN KEY(course_id,script_version) REFERENCES content_review_requests(course_id,script_version));
      INSERT INTO schema_migrations VALUES(6,unixepoch());
    `);
      for (const table of [
        "content_script_authors",
        "content_review_requests",
        "content_review_decisions",
      ])
        db.exec(`
      CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Review records are immutable'); END;
      CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Review records are immutable'); END;
    `);
    });
  if (version < 7)
    transaction(db, () => {
      db.exec(`
      CREATE TABLE content_script_suggestions (
        id TEXT PRIMARY KEY, course_id TEXT NOT NULL, script_version INTEGER NOT NULL,
        paragraph_id TEXT NOT NULL, replacement TEXT NOT NULL, reason TEXT NOT NULL,
        author_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        FOREIGN KEY(course_id,script_version) REFERENCES content_script_versions(course_id,version)
      );
      CREATE INDEX content_suggestions_version ON content_script_suggestions(course_id,script_version,created_at);
      CREATE TABLE content_suggestion_resolutions (
        suggestion_id TEXT PRIMARY KEY REFERENCES content_script_suggestions(id),
        course_id TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
        actor_id TEXT NOT NULL, note TEXT NOT NULL, resolved_at INTEGER NOT NULL,
        result_version INTEGER,
        CHECK((decision='accepted' AND result_version IS NOT NULL) OR (decision='rejected' AND result_version IS NULL)),
        FOREIGN KEY(course_id,result_version) REFERENCES content_script_versions(course_id,version)
      );
      INSERT INTO schema_migrations VALUES(7,unixepoch());
    `);
      for (const table of [
        "content_script_suggestions",
        "content_suggestion_resolutions",
      ])
        db.exec(`
      CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Suggestion records are immutable'); END;
      CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Suggestion records are immutable'); END;
    `);
    });
  if (version < 8)
    transaction(db, () => {
      db.exec(`
      CREATE TABLE content_generation_imports (
        merchant_id TEXT NOT NULL,job_id TEXT NOT NULL,course_id TEXT NOT NULL,script_version INTEGER NOT NULL,
        actor_id TEXT NOT NULL,imported_at INTEGER NOT NULL,snapshot_json TEXT NOT NULL,
        PRIMARY KEY(merchant_id,job_id),FOREIGN KEY(course_id,script_version) REFERENCES content_script_versions(course_id,version)
      );
      CREATE TRIGGER content_generation_imports_immutable_update BEFORE UPDATE ON content_generation_imports
        BEGIN SELECT RAISE(ABORT,'Generation import is immutable'); END;
      CREATE TRIGGER content_generation_imports_immutable_delete BEFORE DELETE ON content_generation_imports
        BEGIN SELECT RAISE(ABORT,'Generation import is immutable'); END;
      INSERT INTO schema_migrations VALUES(8,unixepoch());
    `);
    });
  if (version < 9)
    transaction(db, () => {
      db.exec(`
      CREATE TABLE attribution_stores(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,name TEXT NOT NULL,external_ref TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(merchant_id,external_ref));
      CREATE TABLE attribution_sources(code TEXT PRIMARY KEY,store_id TEXT NOT NULL REFERENCES attribution_stores(id),room_id TEXT NOT NULL REFERENCES rooms(id),label TEXT NOT NULL,created_at INTEGER NOT NULL,disabled_at INTEGER);
      CREATE INDEX attribution_sources_room ON attribution_sources(room_id,store_id);
      CREATE TABLE attribution_visits(room_id TEXT NOT NULL,viewer_id TEXT NOT NULL,source_code TEXT NOT NULL REFERENCES attribution_sources(code),attributed_at INTEGER NOT NULL,watch_seconds_baseline INTEGER NOT NULL,
        PRIMARY KEY(room_id,viewer_id),FOREIGN KEY(room_id,viewer_id) REFERENCES visits(room_id,viewer_id));
      CREATE TABLE offline_batches(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,store_id TEXT NOT NULL REFERENCES attribution_stores(id),idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,source_name TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,receipt_json TEXT NOT NULL,UNIQUE(merchant_id,idempotency_key));
      CREATE TABLE offline_records(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,store_id TEXT NOT NULL REFERENCES attribution_stores(id),kind TEXT NOT NULL CHECK(kind IN ('visit','order','cost')),external_id TEXT NOT NULL,revision INTEGER NOT NULL,
        source_code TEXT NOT NULL,linked_source_code TEXT REFERENCES attribution_sources(code),match_state TEXT NOT NULL,customer_ref TEXT NOT NULL,occurred_at INTEGER NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),voided INTEGER NOT NULL CHECK(voided IN (0,1)),note TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,batch_id TEXT NOT NULL REFERENCES offline_batches(id),
        UNIQUE(merchant_id,store_id,kind,external_id,revision));
      CREATE INDEX offline_records_source ON offline_records(linked_source_code);
      CREATE INDEX offline_records_store ON offline_records(merchant_id,store_id,occurred_at);
      INSERT INTO schema_migrations VALUES(9,unixepoch());
    `);
      for (const table of [
        "attribution_visits",
        "offline_batches",
        "offline_records",
      ])
        db.exec(`
      CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Attribution history is immutable'); END;
      CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Attribution history is immutable'); END;
    `);
    });
  if (version < 10)
    transaction(db, () => {
      db.exec(`
        CREATE TABLE engagement_programs(room_id TEXT NOT NULL REFERENCES rooms(id),version INTEGER NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),points INTEGER NOT NULL CHECK(points BETWEEN 1 AND 10000),min_watch_seconds INTEGER NOT NULL CHECK(min_watch_seconds BETWEEN 0 AND 14400),daily_limit INTEGER NOT NULL CHECK(daily_limit BETWEEN 1 AND 100000),actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(room_id,version));
        CREATE TABLE engagement_checkins(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id),viewer_id TEXT NOT NULL,day TEXT NOT NULL,program_version INTEGER NOT NULL,points INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(room_id,viewer_id,day));
        CREATE TABLE engagement_points(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,viewer_id TEXT NOT NULL,delta INTEGER NOT NULL CHECK(delta!=0),reason TEXT NOT NULL,reference_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(reason,reference_id));
        CREATE INDEX engagement_points_balance ON engagement_points(merchant_id,viewer_id);
        CREATE TABLE engagement_gifts(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,points INTEGER NOT NULL CHECK(points>0),stock INTEGER NOT NULL CHECK(stock>=0),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),version INTEGER NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE engagement_gift_history(id TEXT PRIMARY KEY,gift_id TEXT NOT NULL REFERENCES engagement_gifts(id),version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(gift_id,version));
        CREATE TABLE engagement_redemptions(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,viewer_id TEXT NOT NULL,gift_id TEXT NOT NULL REFERENCES engagement_gifts(id),title TEXT NOT NULL,points INTEGER NOT NULL,code TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN('reserved','fulfilled','cancelled')),idempotency_key TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(merchant_id,viewer_id,idempotency_key));
        CREATE TABLE engagement_events(id TEXT PRIMARY KEY,redemption_id TEXT NOT NULL REFERENCES engagement_redemptions(id),state TEXT NOT NULL,actor_id TEXT NOT NULL,note TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(redemption_id,state));
        CREATE INDEX engagement_redemptions_owner ON engagement_redemptions(merchant_id,viewer_id,created_at);
      `);
      for (const table of [
        "engagement_programs",
        "engagement_checkins",
        "engagement_points",
        "engagement_gift_history",
        "engagement_events",
      ]) {
        db.exec(
          `CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END;`,
        );
      }
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        10,
        Date.now(),
      );
    });
  if (version < 11)
    transaction(db, () => {
      db.exec(`CREATE TABLE content_profile_revocations(merchant_id TEXT NOT NULL,profile_id TEXT NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL,revoked_at INTEGER NOT NULL,PRIMARY KEY(merchant_id,profile_id));
      CREATE TRIGGER content_profile_revocations_immutable_update BEFORE UPDATE ON content_profile_revocations BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER content_profile_revocations_immutable_delete BEFORE DELETE ON content_profile_revocations BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TABLE content_authorization_checks(merchant_id TEXT NOT NULL,profile_id TEXT NOT NULL,verified_at INTEGER NOT NULL,PRIMARY KEY(merchant_id,profile_id));`);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        11,
        Date.now(),
      );
    });
  if (version < 12)
    transaction(db, () => {
      db.exec(`
        CREATE TABLE complaints(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id),merchant_id TEXT NOT NULL,viewer_id TEXT NOT NULL,category TEXT NOT NULL,body TEXT NOT NULL,idempotency_key TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(viewer_id,idempotency_key));
        CREATE INDEX complaints_owner ON complaints(merchant_id,room_id,id);
        CREATE INDEX complaints_viewer ON complaints(viewer_id,room_id,id);
        CREATE TABLE complaint_events(complaint_id TEXT NOT NULL REFERENCES complaints(id),version INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('received','reviewing','resolved')),reply TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(complaint_id,version));
      `);
      for (const table of ["complaints", "complaint_events"])
        db.exec(
          `CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END;`,
        );
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        12,
        Date.now(),
      );
    });
  if (version < 13)
    transaction(db, () => {
      db.exec(`CREATE TABLE disclosure_versions(merchant_id TEXT NOT NULL,version INTEGER NOT NULL,data_json TEXT NOT NULL,evidence_reference TEXT NOT NULL,author_id TEXT NOT NULL,created_at INTEGER NOT NULL,entity_type TEXT NOT NULL CHECK(entity_type='enterprise'),PRIMARY KEY(merchant_id,version));
      CREATE TABLE disclosure_events(id INTEGER PRIMARY KEY AUTOINCREMENT,merchant_id TEXT NOT NULL,version INTEGER NOT NULL,action TEXT NOT NULL CHECK(action IN('publish','withdraw')),actor_id TEXT NOT NULL,note TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(merchant_id,version) REFERENCES disclosure_versions(merchant_id,version));
      CREATE INDEX disclosure_events_owner ON disclosure_events(merchant_id,id);`);
      for (const table of ["disclosure_versions", "disclosure_events"])
        db.exec(
          `CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END;`,
        );
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        13,
        Date.now(),
      );
    });
  if (version < 14)
    transaction(db, () => {
      db.exec(`CREATE TABLE live_admissions(id INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT NOT NULL REFERENCES rooms(id),merchant_id TEXT NOT NULL,actor_id TEXT NOT NULL,basis_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX live_admissions_room ON live_admissions(room_id,id);
      CREATE TRIGGER live_admissions_immutable_update BEFORE UPDATE ON live_admissions BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER live_admissions_immutable_delete BEFORE DELETE ON live_admissions BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        14,
        Date.now(),
      );
    });
  if (version < 15)
    transaction(db, () => {
      db.exec(`CREATE TABLE moderation_actions(id INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT NOT NULL REFERENCES rooms(id),merchant_id TEXT NOT NULL,actor_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('note','stop','release')),note TEXT NOT NULL,evidence_reference TEXT NOT NULL,hold_id INTEGER REFERENCES moderation_actions(id),idempotency_key TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(merchant_id,idempotency_key));
      CREATE INDEX moderation_actions_room ON moderation_actions(room_id,id);
      CREATE TABLE moderation_results(id INTEGER PRIMARY KEY AUTOINCREMENT,action_id INTEGER NOT NULL REFERENCES moderation_actions(id),disconnected INTEGER NOT NULL CHECK(disconnected IN(0,1)),message TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL);`);
      for (const table of ["moderation_actions", "moderation_results"])
        db.exec(
          `CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END;`,
        );
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        15,
        Date.now(),
      );
    });
  if (version < 16)
    transaction(db, () => {
      db.exec(`CREATE TABLE recordings(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,room_id TEXT NOT NULL REFERENCES rooms(id),relative_path TEXT NOT NULL UNIQUE,started_at INTEGER NOT NULL,completed_at INTEGER NOT NULL,duration_seconds REAL NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,registered_at INTEGER NOT NULL);
      CREATE INDEX recordings_room ON recordings(room_id,id);
      CREATE TABLE recording_ingest_errors(receipt TEXT PRIMARY KEY,merchant_id TEXT,message TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TRIGGER recordings_immutable_update BEFORE UPDATE ON recordings BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER recordings_immutable_delete BEFORE DELETE ON recordings BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        16,
        Date.now(),
      );
    });
  if (version < 17)
    transaction(db, () => {
      db.exec(
        "CREATE TABLE home_preferences(merchant_id TEXT NOT NULL,actor_id TEXT NOT NULL,layout_json TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(merchant_id,actor_id))",
      );
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        17,
        Date.now(),
      );
    });
  if (version < 18)
    transaction(db, () => {
      db.exec(`CREATE TABLE team_access(actor_id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,disabled INTEGER NOT NULL CHECK(disabled IN(0,1)),version INTEGER NOT NULL);
    CREATE TABLE team_access_events(id INTEGER PRIMARY KEY AUTOINCREMENT,merchant_id TEXT NOT NULL,target_actor_id TEXT NOT NULL,actor_id TEXT NOT NULL,disabled INTEGER NOT NULL,reason TEXT NOT NULL,version INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TRIGGER team_access_events_no_update BEFORE UPDATE ON team_access_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER team_access_events_no_delete BEFORE DELETE ON team_access_events BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        18,
        Date.now(),
      );
    });
  if (version < 19)
    transaction(db, () => {
      db.exec(`ALTER TABLE team_access ADD COLUMN role_override TEXT CHECK(role_override IN ('editor','reviewer','presenter','analyst'));
      ALTER TABLE team_access ADD COLUMN base_role TEXT;
      ALTER TABLE team_access_events ADD COLUMN from_role TEXT;
      ALTER TABLE team_access_events ADD COLUMN to_role TEXT;`);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        19,
        Date.now(),
      );
    });
  if (version < 20)
    transaction(db, () => {
      db.exec(`CREATE TABLE complaint_appeals(id TEXT PRIMARY KEY,complaint_id TEXT NOT NULL REFERENCES complaints(id),merchant_id TEXT NOT NULL,viewer_id TEXT NOT NULL,reason TEXT NOT NULL,idempotency_key TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(complaint_id),UNIQUE(viewer_id,idempotency_key));
      CREATE INDEX complaint_appeals_owner ON complaint_appeals(merchant_id,id);
      CREATE TABLE complaint_appeal_events(appeal_id TEXT NOT NULL REFERENCES complaint_appeals(id),version INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('submitted','reviewing','resolved')),reply TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(appeal_id,version));`);
      for (const table of ["complaint_appeals", "complaint_appeal_events"])
        db.exec(
          `CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END;`,
        );
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        20,
        Date.now(),
      );
    });
  if (version < 21)
    transaction(db, () => {
      db.exec(`CREATE TABLE speech_segments(
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id),
        provider TEXT NOT NULL CHECK(provider IN('webhook')),
        provider_event_id TEXT NOT NULL,
        text TEXT NOT NULL,
        live_started_at INTEGER NOT NULL,
        started_offset_ms INTEGER NOT NULL CHECK(started_offset_ms>=0),
        ended_offset_ms INTEGER NOT NULL CHECK(ended_offset_ms>=started_offset_ms),
        received_at INTEGER NOT NULL,
        UNIQUE(room_id,live_started_at,provider,provider_event_id)
      );
      CREATE INDEX speech_segments_room ON speech_segments(room_id,received_at DESC);
      CREATE TABLE speech_segment_analyses(
        segment_id TEXT PRIMARY KEY REFERENCES speech_segments(id),
        agent_run_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TRIGGER speech_segments_immutable_update BEFORE UPDATE ON speech_segments BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER speech_segments_immutable_delete BEFORE DELETE ON speech_segments BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER speech_segment_analyses_immutable_update BEFORE UPDATE ON speech_segment_analyses BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER speech_segment_analyses_immutable_delete BEFORE DELETE ON speech_segment_analyses BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        21,
        Date.now(),
      );
    });
  if (version < 22)
    transaction(db, () => {
      db.exec(`CREATE TABLE speech_analysis_jobs(
        segment_id TEXT PRIMARY KEY REFERENCES speech_segments(id),
        state TEXT NOT NULL CHECK(state IN('pending','running','completed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX speech_analysis_jobs_due ON speech_analysis_jobs(state,next_attempt_at);
      INSERT INTO speech_analysis_jobs(segment_id,state,next_attempt_at,updated_at)
        SELECT id,'pending',received_at,received_at FROM speech_segments
        WHERE id NOT IN (SELECT segment_id FROM speech_segment_analyses);`);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        22,
        Date.now(),
      );
    });
  if (version < 23)
    transaction(db, () => {
      db.exec(`CREATE TABLE recording_retention_holds(
        id TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        merchant_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN('dispute','regulatory','business')),
        reason TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(merchant_id,idempotency_key)
      );
      CREATE INDEX recording_retention_holds_recording ON recording_retention_holds(recording_id,created_at);
      CREATE TABLE recording_retention_hold_events(
        hold_id TEXT NOT NULL REFERENCES recording_retention_holds(id),
        version INTEGER NOT NULL CHECK(version>0),
        state TEXT NOT NULL CHECK(state IN('active','released')),
        note TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(hold_id,version)
      );
      CREATE TABLE recording_deletion_requests(
        id TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL REFERENCES recordings(id),
        merchant_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(merchant_id,idempotency_key)
      );
      CREATE INDEX recording_deletion_requests_recording ON recording_deletion_requests(recording_id,created_at);
      CREATE TABLE recording_deletion_events(
        request_id TEXT NOT NULL REFERENCES recording_deletion_requests(id),
        version INTEGER NOT NULL CHECK(version>0),
        state TEXT NOT NULL CHECK(state IN('requested','approved','rejected','deleting','deleted','failed')),
        note TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(request_id,version)
      );
      CREATE INDEX recording_deletion_events_state ON recording_deletion_events(state,created_at);
      `);
      for (const table of [
        "recording_retention_holds",
        "recording_retention_hold_events",
        "recording_deletion_requests",
        "recording_deletion_events",
      ])
        db.exec(
          `CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END;`,
        );
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        23,
        Date.now(),
      );
    });
  if (version < 24)
    transaction(db, () => {
      db.exec(`CREATE TABLE speech_relay_status(
        room_id TEXT PRIMARY KEY REFERENCES rooms(id),
        live_started_at INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN('starting','ready','degraded','stopped')),
        code TEXT NOT NULL CHECK(code IN('waiting_audio','flowing','delivery_failed','source_stopped','source_failed')),
        updated_at INTEGER NOT NULL
      );`);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(
        24,
        Date.now(),
      );
    });
  return db;
}
export type DB = ReturnType<typeof openDatabase>;
export function transaction<T>(db: DB, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = action();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
