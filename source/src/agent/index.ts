import { serve } from "@hono/node-server";
import { loadAgentConfig } from "./config.js";
import { openAgentDatabase } from "./db.js";
import { createAgentService } from "./app.js";

const config = loadAgentConfig();
const db = openAgentDatabase(config.databasePath);
const service = createAgentService(db, config);
const server = serve(
  { fetch: service.app.fetch, hostname: config.host, port: config.port },
  () => {
    console.log(
      `Agent service ready at http://${config.host}:${config.port}; provider=${service.status().provider}`,
    );
  },
);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await service.close();
  db.close();
}
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
