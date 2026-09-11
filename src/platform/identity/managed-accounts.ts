import type { DB } from "../../shared/persistence.js";
import type { Config } from "../infrastructure/public.js";
import { findManagedAccount } from "./persistence/accounts.js";
export function managedAccount(db: DB | undefined, config: Config, actor: string) {
  if (!db) return undefined;
  const account = findManagedAccount(db, actor);
  if (!account || config.merchantCredentials[actor] || actor === "demo") return undefined;
  const ownerExists = (config.demoMode && account.merchant_id === "demo") ||
    (Boolean(config.merchantCredentials[account.merchant_id]) && !config.merchantMemberships?.[account.merchant_id]);
  return ownerExists ? account : undefined;
}
