import { recordingTools } from "./recordings.js";
let tools: ReturnType<typeof recordingTools> | undefined;
try {
  const args = process.argv.slice(2);
  if (
    args.length !== 1 ||
    !args[0].startsWith("--out=") ||
    !args[0].slice(6) ||
    !process.env.DATABASE_PATH ||
    !process.env.RECORDINGS_ROOT
  )
    throw new Error("使用 DATABASE_PATH、RECORDINGS_ROOT 和 --out=全新目录");
  tools = recordingTools(process.env.DATABASE_PATH,process.env.RECORDINGS_ROOT||"",process.env.RECORDING_OUTBOX||"");
  console.log(
    JSON.stringify(
      await tools.backup(
        args[0].slice(6),
      ),
      null,
      2,
    ),
  );
} catch {
  console.error(
    "备份未完成，请检查源数据库、录像与目标目录；已有备份不会被覆盖。",
  );
  process.exitCode = 1;
} finally {
  tools?.close();
}
