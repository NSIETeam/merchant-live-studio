import type { DB, SQLValue } from "../../../shared/persistence.js";

export function listContentScriptSuggestionsByCourseIdAndScriptVersion(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "\n    SELECT s.id,s.course_id AS courseId,s.script_version AS scriptVersion,s.paragraph_id AS paragraphId,\n      s.replacement,s.reason,s.author_id AS authorId,s.created_at AS createdAt,\n      r.decision,r.actor_id AS resolvedBy,r.note AS resolutionNote,r.resolved_at AS resolvedAt,r.result_version AS resultVersion\n    FROM content_script_suggestions s LEFT JOIN content_suggestion_resolutions r ON r.suggestion_id=s.id\n    WHERE s.course_id=? AND s.script_version=? ORDER BY s.created_at,s.id\n  ",
    )
    .all(...values);
}

export function findContentScriptSuggestionsById(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("SELECT * FROM content_script_suggestions WHERE id=?")
    .get(...values);
}

export function insertContentScriptSuggestions(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO content_script_suggestions VALUES(?,?,?,?,?,?,?,?)")
    .run(...values);
}

export function findContentSuggestionResolutionsBySuggestionId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM content_suggestion_resolutions WHERE suggestion_id=?",
    )
    .get(...values);
}

export function insertContentSuggestionResolutions(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("INSERT INTO content_suggestion_resolutions VALUES(?,?,?,?,?,?,?)")
    .run(...values);
}
