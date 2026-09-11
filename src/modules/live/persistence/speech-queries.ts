import type { DB, SQLValue } from "../../../shared/persistence.js";

export function insertSpeechSegment(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT OR IGNORE INTO speech_segments(id,room_id,provider,provider_event_id,text,live_started_at,started_offset_ms,ended_offset_ms,received_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(...values);
}

export function findSpeechSegmentByEvent(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM speech_segments WHERE room_id=? AND live_started_at=? AND provider=? AND provider_event_id=?",
    )
    .get(...values);
}

export function listRecentSpeechSegments(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT text FROM speech_segments WHERE room_id=? AND live_started_at=? ORDER BY ended_offset_ms DESC,received_at DESC LIMIT ?",
    )
    .all(...values);
}

export function findLatestSpeechSegment(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT s.*,a.agent_run_id,j.state AS analysis_job_state,j.attempts AS analysis_attempts,j.last_error AS analysis_last_error FROM speech_segments s LEFT JOIN speech_segment_analyses a ON a.segment_id=s.id LEFT JOIN speech_analysis_jobs j ON j.segment_id=s.id WHERE s.room_id=? ORDER BY s.received_at DESC,s.id DESC LIMIT 1",
    )
    .get(...values);
}

export function findSpeechAnalysis(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT agent_run_id,created_at FROM speech_segment_analyses WHERE segment_id=?",
    )
    .get(...values);
}

export function insertSpeechAnalysis(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT OR IGNORE INTO speech_segment_analyses(segment_id,agent_run_id,created_at) VALUES(?,?,?)",
    )
    .run(...values);
}

export function insertSpeechAnalysisJob(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT OR IGNORE INTO speech_analysis_jobs(segment_id,state,next_attempt_at,updated_at) VALUES(?,'pending',?,?)",
    )
    .run(...values);
}

export function resetRunningSpeechAnalysisJobs(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE speech_analysis_jobs SET state='pending',next_attempt_at=?,last_error='process_restarted',updated_at=? WHERE state='running'",
    )
    .run(...values);
}

export function listDueSpeechAnalysisJobs(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT j.segment_id,j.attempts,s.*,r.merchant_id FROM speech_analysis_jobs j JOIN speech_segments s ON s.id=j.segment_id JOIN rooms r ON r.id=s.room_id WHERE j.state='pending' AND j.next_attempt_at<=? ORDER BY j.next_attempt_at,s.received_at LIMIT ?",
    )
    .all(...values);
}

export function claimSpeechAnalysisJob(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE speech_analysis_jobs SET state='running',attempts=attempts+1,updated_at=? WHERE segment_id=? AND state='pending'",
    )
    .run(...values);
}

export function completeSpeechAnalysisJob(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE speech_analysis_jobs SET state='completed',last_error='',updated_at=? WHERE segment_id=?",
    )
    .run(...values);
}

export function retrySpeechAnalysisJob(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE speech_analysis_jobs SET state='pending',next_attempt_at=?,last_error=?,updated_at=? WHERE segment_id=?",
    )
    .run(...values);
}
