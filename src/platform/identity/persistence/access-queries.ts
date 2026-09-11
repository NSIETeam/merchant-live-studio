import type { DB, SQLValue } from "../../../shared/persistence.js";
export function findSessionAccess(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT disabled,version FROM team_access WHERE actor_id=?").get(...values); }
