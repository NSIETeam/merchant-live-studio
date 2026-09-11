import { serve } from "@hono/node-server";
import {
  createAgentRuntime,
  loadAgentConfig,
} from "../modules/agent/public.js";

const config = loadAgentConfig();
const service = createAgentRuntime(config);
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
}
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
