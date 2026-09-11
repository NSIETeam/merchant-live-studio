import { enqueueCompletedSegment } from "../platform/infrastructure/public.js";
enqueueCompletedSegment().catch((error) => {
  console.error(
    "Recording completion queue failed:",
    error instanceof Error ? error.message : "unknown",
  );
  process.exitCode = 1;
});
