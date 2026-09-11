import type { DB } from "../../../shared/persistence.js";
export function generationSources(db: DB, tenant: string, course?: string, version?: number) {
 const rows = db.prepare("SELECT course_id,script_version AS version,json_extract(snapshot_json,'$.input.profileId') AS profile FROM content_generation_imports WHERE merchant_id=? ORDER BY script_version").all(tenant);
 return rows.filter(r => (!course || r.course_id===course) && (version===undefined || Number(r.version)<=version)).map(r=>({version:Number(r.version),profile:String(r.profile)}));
}
