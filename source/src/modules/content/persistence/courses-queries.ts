import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findContentCoursesById(db: DB, ...values: SQLValue[]) {
  return db.prepare("SELECT * FROM content_courses WHERE id=?").get(...values);
}

export function findContentScriptVersionsByCourseIdAndVersion(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM content_script_versions WHERE course_id=? AND version=?",
    )
    .get(...values);
}

export function insertContentScriptVersions(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO content_script_versions VALUES(?,?,?,?,?,?,?,?,?)")
    .run(...values);
}

export function updateContentCoursesById(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("UPDATE content_courses SET latest_script_version=? WHERE id=?")
    .run(...values);
}

export function insertContentScriptAuthors(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO content_script_authors VALUES(?,?,?)")
    .run(...values);
}

export function listContentCoursesByPlanId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM content_courses WHERE plan_id=? ORDER BY day_index,created_at,rowid",
    )
    .all(...values);
}

export function findContentCoursesByPlanId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT COALESCE(MAX(day_index),0) AS n FROM content_courses WHERE plan_id=?",
    )
    .get(...values);
}

export function findContentScriptAuthorsByCourseIdAndScriptVersion(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT actor_id FROM content_script_authors WHERE course_id=? AND script_version=?",
    )
    .get(...values);
}

export function findContentCoursesById2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT latest_script_version AS v FROM content_courses WHERE id=?",
    )
    .get(...values);
}

export function listContentCourses(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM content_courses WHERE plan_id IN (SELECT value FROM json_each(?)) ORDER BY id",
    )
    .all(...values);
}

export function insertContentCourses(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO content_courses VALUES(?,?,?,?,?,?,?,?,0,?)")
    .run(...values);
}

export function listContentScriptVersionsByCourseId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT version FROM content_script_versions WHERE course_id=? ORDER BY version DESC",
    )
    .all(...values);
}

export function updateContentCoursesById2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE content_courses SET title=?,day_index=?,objective=?,duration_minutes=?,schedule_label=?,presenter_name=? WHERE id=?",
    )
    .run(...values);
}
