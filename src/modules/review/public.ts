import { contentAuthorizationIssue, createContentAuthorizationSync, recordProfileRevocation } from "./content-authorization.js";
import type { AgentProfile } from "../../shared/agent.js";
import type { AgentBridge } from "../../platform/adapters/public.js";
import type { Hono } from "hono";
import type {
  ConfirmationRow,
  ContentPort,
  ReviewPort,
} from "../../shared/content-ports.js";
import type { DB } from "../../shared/persistence.js";
import { attachConfirmation } from "./confirmation.js";
import { checkScript, CONTENT_RULE_VERSION } from "./content-check.js";
import { findContentScriptConfirmationsByCourseIdAndScriptVersion } from "./persistence/public-queries.js";
import { attachScriptReview, readScriptReview } from "./script-review.js";
import { attachScriptSuggestions } from "./script-suggestions.js";
export { checkScript, CONTENT_RULE_VERSION } from "./content-check.js";
export function createReview(
  db: DB,
  content: ContentPort,
  clock: () => number = Date.now,
  bridge?: AgentBridge,
) {
  const review: ReviewPort = {
    authorizationIssue: (tenant, course, version, now = clock()) => contentAuthorizationIssue(db, tenant, course, version, now, content),
    readScriptReview: (id, version) =>
      readScriptReview(db, id, version, content),
    readConfirmation: (id, version) =>
      findContentScriptConfirmationsByCourseIdAndScriptVersion(
        db,
        id,
        version,
      ) as unknown as ConfirmationRow | undefined,
    checkScript,
    ruleVersion: CONTENT_RULE_VERSION,
  };
  return {
    ...review,
    syncAuthorization: bridge ? createContentAuthorizationSync(db, bridge, clock, content) : async (_tenant: string) => {},
    recordProfileRevocation: (tenant: string, profile: AgentProfile) => recordProfileRevocation(db, tenant, profile),
    attach(app: Hono<{ Variables: { merchantId: string; viewerId: string } }>) {
      attachScriptSuggestions(
        app,
        db,
        content.scriptVersion,
        content.saveScript,
        clock,
        content,
      );
      attachScriptReview(app, db, content.scriptVersion, clock, content);
      attachConfirmation(app, db, content, review, clock);
    },
  };
}

export { attachDisclosure, disclosureState } from "./disclosure.js";
export { attachComplaints } from "./complaints.js";
