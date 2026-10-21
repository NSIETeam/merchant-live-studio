export { createBindings } from "./bindings.js";

export { attachLiveAssistance } from "./agent-assistance.js";
export { MediaController } from "./media-control.js";
export { recordPresence } from "./presence.js";
export { createLive } from "./rooms.js";
export { createStreamAdapter } from "./stream.js";

export { createSourceViewing } from "./attribution.js";

export { attachRecordings, processRecordingOutbox } from "./recordings.js";

export { auditRecordings } from "./recording-audit.js";

export { backupRegisteredRecordings } from "./recording-backup.js";
import { openRecordingRegistry } from "./persistence/recording-snapshot.js";
import { auditRecordings as audit } from "./recording-audit.js";
import { backupRegisteredRecordings as backup } from "./recording-backup.js";
import type { createRecordingStorage,createRecordingBackupFiles } from "../../platform/infrastructure/public.js";
export function createRecordingTools(path:string) {
 const db=openRecordingRegistry(path);
 return { close:()=>db.close(),audit:(root:string,outbox:string,after:string,limit:number,storage:ReturnType<typeof createRecordingStorage>)=>audit(db,root,outbox,after,limit,storage),backup:(files:()=>ReturnType<typeof createRecordingBackupFiles>)=>backup(db,files) };
}
