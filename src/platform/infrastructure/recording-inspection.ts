import { readdir,statfs } from "node:fs/promises";
import { join } from "node:path";
export async function inspectRecordingStorage(root:string,outbox:string) {
 const result = {storage:null as {availableBytes:number;totalBytes:number;lowSpace:boolean}|null,queue:null as {pending:number;failed:number;processed:number}|null,warnings:[] as string[]};
  try {
    const space = await statfs(root);
    const availableBytes = space.bavail * space.bsize,
      totalBytes = space.blocks * space.bsize;
    result.storage = {
      availableBytes,
      totalBytes,
      lowSpace: totalBytes <= 0 || availableBytes / totalBytes < 0.1,
    };
    if (result.storage.lowSpace)
      result.warnings.push(
        "录像所在文件系统可用空间低于 10%，请及时扩容或按批准的留存策略处理。",
      );
  } catch {
    result.warnings.push("无法读取录像所在文件系统容量。");
  }
  try {
    const count = async (path: string, optional = false) =>
      (
        await readdir(path).catch((error: NodeJS.ErrnoException) => {
          if (optional && error.code === "ENOENT") return [];
          throw error;
        })
      ).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length;
    result.queue = {
      pending: await count(outbox),
      failed: await count(join(outbox, "failed"), true),
      processed: await count(join(outbox, "processed"), true),
    };
    if (result.queue.failed)
      result.warnings.push("存在已隔离的完成回执，需要核对登记失败原因。");
    if (result.queue.pending)
      result.warnings.push("仍有完成回执等待登记；本次巡检不包含未登记片段。");
  } catch {
    result.warnings.push("无法读取录像完成队列。");
  }
  return result;
}
