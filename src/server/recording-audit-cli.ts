import { DatabaseSync } from "node:sqlite";
import { auditRecordings } from "./recording-audit.js";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "录像只读巡检：使用 DATABASE_PATH、RECORDINGS_ROOT、RECORDING_OUTBOX。可选 --after=<id> --limit=100；输出 JSON。退出码 0=本页通过，2=异常或警告，1=执行失败。nextAfter 非空时仍需检查后续页。建议在停播后的数据库和录像一致性备份副本上做完整巡检。",
  );
} else {
  let db: DatabaseSync | undefined;
  try {
    if (args.some((arg) => !/^--(?:after|limit)=/.test(arg)))
      throw new Error("不支持的巡检参数");
    const after =
      args.find((arg) => arg.startsWith("--after="))?.slice(8) || "";
    const limit = Number(
      args.find((arg) => arg.startsWith("--limit="))?.slice(8) || "100",
    );
    if (!process.env.DATABASE_PATH)
      throw new Error("必须配置 DATABASE_PATH，巡检不会创建数据库");
    db = new DatabaseSync(process.env.DATABASE_PATH, { readOnly: true });
    const result = await auditRecordings(
      db,
      process.env.RECORDINGS_ROOT || "",
      process.env.RECORDING_OUTBOX || "",
      after,
      limit,
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.issues.length || result.warnings.length) process.exitCode = 2;
  } catch {
    console.error(
      "录像巡检未完成。请核对参数、数据库版本、目录配置及读取权限；未修改任何录像或登记记录。",
    );
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
