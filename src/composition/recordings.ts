import { auditRecordings as audit } from "../modules/live/public.js";
import { createRecordingStorage } from "../platform/infrastructure/public.js";
import type { DB } from "../shared/persistence.js";
export function auditRecordings(db:DB,root:string,outbox:string,after="",limit=100) { return audit(db,root,outbox,after,limit,createRecordingStorage(root,outbox)); }

import { backupRegisteredRecordings as backup,createRecordingTools } from "../modules/live/public.js";
import { createRecordingBackupFiles } from "../platform/infrastructure/public.js";
export function backupRegisteredRecordings(db:DB,root:string,destination:string) { return backup(db,()=>createRecordingBackupFiles(root,destination)); }
export function recordingTools(path:string,root:string,outbox:string) {
 const tools=createRecordingTools(path);return {close:tools.close,audit:(after="",limit=100)=>tools.audit(root,outbox,after,limit,createRecordingStorage(root,outbox)),backup:(destination:string)=>tools.backup(()=>createRecordingBackupFiles(root,destination))};
}
