import type { DB, SQLValue } from "../../../shared/persistence.js";
export function findRoleOverride(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT role_override FROM team_access WHERE actor_id=? AND merchant_id=? AND base_role=?").get(...values); }
