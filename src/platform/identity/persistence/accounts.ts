import type { DB } from "../../../shared/persistence.js";
import { transaction } from "../../infrastructure/public.js";
export type AccountRole = "editor" | "reviewer" | "presenter" | "analyst";
export interface StoredAccount {
  actor_id: string; merchant_id: string; role: AccountRole;
  verifier: string; credential_version: number; created_at: number;
}
/** Additive identity-owned schema; does not alter legacy configuration accounts. */
export function createAccountStore(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS identity_accounts (
    actor_id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('editor','reviewer','presenter','analyst')),
    verifier TEXT NOT NULL, credential_version INTEGER NOT NULL CHECK(credential_version>0),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK(actor_id<>merchant_id)
  );
  CREATE TABLE IF NOT EXISTS identity_account_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, merchant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL, performed_by TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('create','reset')),
    credential_version INTEGER NOT NULL, request_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(merchant_id,request_key)
  );
  CREATE INDEX IF NOT EXISTS identity_accounts_merchant ON identity_accounts(merchant_id,actor_id);
  CREATE TRIGGER IF NOT EXISTS identity_account_events_no_update BEFORE UPDATE ON identity_account_events BEGIN SELECT RAISE(ABORT,'immutable account event'); END;
  CREATE TRIGGER IF NOT EXISTS identity_account_events_no_delete BEFORE DELETE ON identity_account_events BEGIN SELECT RAISE(ABORT,'immutable account event'); END;`);
  return {
    find(actor: string): StoredAccount | undefined {
      return db.prepare("SELECT * FROM identity_accounts WHERE actor_id=?").get(actor) as unknown as StoredAccount | undefined;
    },
    list(merchant: string) {
      return db.prepare("SELECT actor_id,merchant_id,role,credential_version,created_at FROM identity_accounts WHERE merchant_id=? ORDER BY actor_id").all(merchant);
    },
    history(merchant: string, before: number) {
      return db.prepare("SELECT id,actor_id AS targetActorId,performed_by AS actorId,kind,credential_version AS credentialVersion,created_at AS createdAt FROM identity_account_events WHERE merchant_id=? AND id<? ORDER BY id DESC LIMIT 51").all(merchant,before);
    },
    receipt(merchant: string, request: string) {
      return db.prepare("SELECT actor_id,kind,performed_by,credential_version,request_fingerprint FROM identity_account_events WHERE merchant_id=? AND request_key=?").get(merchant,request);
    },
    create(input: { actor: string; merchant: string; role: AccountRole; verifier: string; operator: string; request: string; fingerprint?: string; now: number }) {
      return transaction(db, () => {
        db.prepare("INSERT INTO identity_accounts(actor_id,merchant_id,role,verifier,credential_version,created_at,updated_at) VALUES(?,?,?,?,1,?,?)").run(input.actor,input.merchant,input.role,input.verifier,input.now,input.now);
        db.prepare("INSERT INTO identity_account_events(merchant_id,actor_id,performed_by,kind,credential_version,request_key,request_fingerprint,created_at) VALUES(?,?,?,'create',1,?,?,?)").run(input.merchant,input.actor,input.operator,input.request,input.fingerprint || "",input.now);
        return 1;
      });
    },
    reset(input: { actor: string; merchant: string; expectedVersion: number; verifier: string; operator: string; request: string; fingerprint?: string; now: number }) {
      return transaction(db, () => {
        const changed = db.prepare("UPDATE identity_accounts SET verifier=?,credential_version=credential_version+1,updated_at=? WHERE actor_id=? AND merchant_id=? AND credential_version=?").run(input.verifier,input.now,input.actor,input.merchant,input.expectedVersion);
        if (!Number(changed.changes)) throw new Error("账号不存在或凭据版本已变化");
        const version = input.expectedVersion+1;
        db.prepare("INSERT INTO identity_account_events(merchant_id,actor_id,performed_by,kind,credential_version,request_key,request_fingerprint,created_at) VALUES(?,?,?,'reset',?,?,?,?)").run(input.merchant,input.actor,input.operator,version,input.request,input.fingerprint || "",input.now);
        return version;
      });
    },
  };
}

export function findManagedAccount(db: DB, actor: string): StoredAccount | undefined {
  return db.prepare("SELECT * FROM identity_accounts WHERE actor_id=?").get(actor) as unknown as StoredAccount | undefined;
}
export function listManagedAccounts(db: DB, merchant: string): StoredAccount[] {
  return db.prepare("SELECT * FROM identity_accounts WHERE merchant_id=? ORDER BY actor_id").all(merchant) as unknown as StoredAccount[];
}
