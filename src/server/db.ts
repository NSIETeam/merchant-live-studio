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
