import test from "node:test";
import assert from "node:assert/strict";
import {
  checkSourceDataOwnership,
  referencedTables,
} from "./check-data-ownership.mjs";
const tables = {
  rooms: "live",
  visits: "live",
  ledger: "payments",
  claims: "engagement",
  agent_runs: "agent",
  revoked_sessions: "identity",
};
const check = (file, source) =>
  checkSourceDataOwnership(file, source, tables).map((e) => e.code);

test("allows own tables and platform-owned session persistence", () => {
  assert.deepEqual(
    check(
      "src/modules/live/persistence/rooms.ts",
      'db.prepare("SELECT * FROM rooms r JOIN visits v ON v.room_id=r.id WHERE r.id=?").all(id)',
    ),
    [],
  );
  assert.deepEqual(
    check(
      "src/platform/identity/persistence/sessions.ts",
      'db.prepare("DELETE FROM revoked_sessions WHERE expires_at<?").run(now)',
    ),
    [],
  );
});
test("cross-module joins, writes and subqueries fail", () => {
  for (const sql of [
    "SELECT * FROM rooms JOIN ledger ON 1=1",
    "SELECT * FROM rooms r, ledger l",
    "INSERT INTO ledger VALUES(?)",
    "SELECT * FROM rooms WHERE id IN (SELECT id FROM claims)",
    "CREATE TABLE ledger(id TEXT)",
    "CREATE TRIGGER x BEFORE UPDATE ON ledger BEGIN SELECT 1; END",
  ]) {
    assert.ok(
      check(
        "src/modules/live/persistence/rooms.ts",
        `db.prepare(${JSON.stringify(sql)})`,
      ).includes("FOREIGN_TABLE"),
    );
  }
});
test("business routes and composition cannot execute even their own SQL", () => {
  assert.ok(
    check(
      "src/modules/live/routes.ts",
      'db.prepare("SELECT * FROM rooms")',
    ).includes("SQL_OUTSIDE_PERSISTENCE"),
  );
  assert.ok(
    check(
      "src/composition/app.ts",
      'db.prepare("SELECT * FROM rooms")',
    ).includes("SQL_OUTSIDE_PERSISTENCE"),
  );
});
test("dynamic SQL and unknown tables fail instead of silently escaping registration", () => {
  assert.ok(
    check(
      "src/modules/live/persistence/rooms.ts",
      "db.prepare(query)",
    ).includes("DYNAMIC_SQL"),
  );
  assert.ok(
    check(
      "src/modules/live/persistence/rooms.ts",
      'db.prepare("SELECT * FROM unowned")',
    ).includes("UNREGISTERED_TABLE"),
  );
});
test("quoted table names are checked and SQL-looking stored values are ignored", () => {
  assert.deepEqual(
    referencedTables(
      `SELECT 'FROM ledger', "id" FROM "main"."rooms" -- JOIN claims\n WHERE title='UPDATE claims'`,
    ),
    ["rooms"],
  );
  assert.ok(
    check(
      "src/modules/live/persistence/rooms.ts",
      "db.prepare('SELECT * FROM [ledger]')",
    ).includes("FOREIGN_TABLE"),
  );
});
test("transaction helper only accepts bounded transaction control", () => {
  assert.deepEqual(
    check(
      "src/platform/infrastructure/transaction.ts",
      'db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE")',
    ),
    [],
  );
  assert.ok(
    check(
      "src/platform/infrastructure/transaction.ts",
      'db.exec("DELETE FROM ledger")',
    ).includes("SQL_OUTSIDE_PERSISTENCE"),
  );
});
test("Agent migrations can enumerate fixed owned tables but cannot construct arbitrary SQL", () => {
  assert.deepEqual(
    check(
      "src/modules/agent/persistence/database.ts",
      "for(const table of [\"agent_runs\"]){db.exec(`UPDATE ${table} SET status='failed'`)}",
    ),
    [],
  );
  assert.ok(
    check(
      "src/modules/agent/persistence/database.ts",
      "db.exec(`UPDATE ${request.table} SET status='failed'`)",
    ).includes("DYNAMIC_SQL"),
  );
});
