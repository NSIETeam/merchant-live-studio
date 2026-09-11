import type { DB } from "../../shared/persistence.js";
import type { createRecordingBackupFiles } from "../../platform/infrastructure/public.js";
import { createRecordingSnapshot } from "./persistence/recording-snapshot.js";
export async function backupRegisteredRecordings(source:DB,createFiles:()=>ReturnType<typeof createRecordingBackupFiles>) {
 const files=await createFiles();let snapshot:Awaited<ReturnType<typeof createRecordingSnapshot>>|undefined;
 try {
  snapshot=await createRecordingSnapshot(source,files.database);
  let after="",count=0,totalBytes=0;
  for(;;){const rows=snapshot.rows(after);if(!rows.length)break;
   for(const row of rows){await files.copy(String(row.relative_path),String(row.room_id),Number(row.bytes),String(row.sha256));count++;totalBytes+=Number(row.bytes);after=String(row.id);}
  }
  snapshot.close();snapshot=undefined;return await files.complete(count,totalBytes);
 }catch(error){snapshot?.close();await files.abort();throw error;}
}
