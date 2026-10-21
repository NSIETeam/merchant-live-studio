import type { DB } from "../../shared/persistence.js";
import type { Config } from "../infrastructure/public.js";
import { findManagedAccount } from "./persistence/accounts.js";
export function managedAccount(
  db: DB | undefined,
  config: Config,
  actor: string,
) {
  if (!db) return undefined;
  const account = findManagedAccount(db, actor);
  if (
    !account ||
    Object.hasOwn(config.merchantCredentials, actor) ||
    actor === "demo"
  )
    return undefined;
  const ownerExists =
    (config.demoMode && account.merchant_id === "demo") ||
    (Object.hasOwn(config.merchantCredentials, account.merchant_id) &&
      !Object.hasOwn(config.merchantMemberships || {}, account.merchant_id));
  return ownerExists ? account : undefined;
}
