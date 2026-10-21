import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findContentReviewRequestsByCourseIdAndScriptVersion(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT submitted_by AS submittedBy,submitted_at AS submittedAt,note FROM content_review_requests WHERE course_id=? AND script_version=?",
    )
    .get(...values);
}

export function findContentReviewDecisionsByCourseIdAndScriptVersion(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT reviewer_id AS reviewerId,reviewed_at AS reviewedAt,decision,note FROM content_review_decisions WHERE course_id=? AND script_version=?",
    )
    .get(...values);
}

export function listContentReviewRequestsByCourseId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT r.course_id,r.script_version,r.submitted_by,r.submitted_at,r.note FROM content_review_requests r LEFT JOIN content_review_decisions d ON d.course_id=r.course_id AND d.script_version=r.script_version WHERE d.course_id IS NULL AND r.course_id>? ORDER BY r.course_id",
    )
    .all(...values);
}

export function insertContentReviewRequests(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO content_review_requests VALUES(?,?,?,?,?)")
    .run(...values);
}

export function findContentScriptSuggestionsByCourseIdAndScriptVersion(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "\n          SELECT count(*) AS n FROM content_script_suggestions s\n          LEFT JOIN content_suggestion_resolutions r ON r.suggestion_id=s.id\n          WHERE s.course_id=? AND s.script_version=? AND r.suggestion_id IS NULL\n        ",
    )
    .get(...values);
}

export function insertContentReviewDecisions(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO content_review_decisions VALUES(?,?,?,?,?,?)")
    .run(...values);
}
