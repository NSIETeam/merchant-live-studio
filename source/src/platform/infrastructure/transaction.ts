import type { DB } from "../../shared/persistence.js";

let sequence = 0;
/** Synchronous module operations may join an existing unit of work using savepoints. */
export function transaction<T>(db: DB, action: () => T): T {
  const nested = db.isTransaction;
  const savepoint = `module_tx_${++sequence}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  try {
    const value = action();
    if (value && typeof (value as { then?: unknown }).then === "function")
      throw new TypeError("Database transactions must complete synchronously");
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return value;
  } catch (error) {
    if (nested) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } else db.exec("ROLLBACK");
    throw error;
  }
}
