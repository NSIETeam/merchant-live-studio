import { inspectRecordingStorage } from "./recording-inspection.js";
import { readdir,readFile,lstat,mkdir,link,unlink,rename } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { hashRecording,completionSchema } from "./recording-files.js";
import { recordingStorageState } from "./recording-health.js";
export function createRecordingStorage(root:string,outbox:string) {
 const receipt=(name:string)=>{if(!/^[a-f0-9]{64}\.json$/.test(name))throw Error("完成回执名称无效");return join(outbox,name);};
 return {
  inspect:()=>inspectRecordingStorage(root,outbox),
  health:()=>recordingStorageState(root,outbox),
  async pending(){return (await readdir(outbox).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;})).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort().slice(0,20);},
  async readReceipt(name:string){const file=receipt(name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw Error("完成回执不是有效文件");return completionSchema.parse(JSON.parse(await readFile(file,'utf8')));},
  async verify(path:string,room:string){const verified=await hashRecording(root,path,room);return {bytes:verified.bytes,sha256:verified.sha256,close:()=>verified.handle.close(),stream:()=>Readable.toWeb(verified.handle.createReadStream({start:0,autoClose:true})) as ReadableStream};},
  async processed(name:string){const file=receipt(name),folder=join(outbox,'processed');await mkdir(folder,{recursive:true,mode:0o700});await link(file,join(folder,name)).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='EEXIST')throw error;});await unlink(file);},
  async failed(name:string){const file=receipt(name),folder=join(outbox,'failed');await mkdir(folder,{recursive:true,mode:0o700});await rename(file,join(folder,name));},
 };
}
