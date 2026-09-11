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
) {
  const review: ReviewPort = {
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
