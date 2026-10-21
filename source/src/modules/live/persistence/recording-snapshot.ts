import { DatabaseSync,backup } from "node:sqlite";
import { chmod } from "node:fs/promises";
import type { DB } from "../../../shared/persistence.js";
export async function createRecordingSnapshot(source:DB,destination:string) {
 await backup(source as DatabaseSync,destination);await chmod(destination,0o600);
 const snapshot=new DatabaseSync(destination,{readOnly:true});
 try { const integrity=snapshot.prepare("PRAGMA integrity_check").all();if(integrity.length!==1||Object.values(integrity[0])[0]!=="ok")throw Error("数据库副本完整性检查失败"); }
 catch(error){snapshot.close();throw error;}
 return {
  rows:(after:string)=>snapshot.prepare("SELECT id,room_id,relative_path,sha256,bytes FROM recordings WHERE id>? ORDER BY id LIMIT 100").all(after),
  close:()=>snapshot.close(),
 };
}
export function openRecordingRegistry(path:string) { return new DatabaseSync(path,{readOnly:true}); }
