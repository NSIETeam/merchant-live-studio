import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createApp, seedDemo } from "./app.js";
import { processSimulationJobs } from "./services/payments.js";
import { expireCampaigns } from "./services/rewards.js";
const config = loadConfig();
const db = openDatabase(config.databasePath);
if (config.demoMode) seedDemo(db);
const app = createApp(db, config);
if (existsSync("dist/web/index.html")) {
  app.get("/assets/*", serveStatic({ root: "./dist/web" }));
  app.get("/", serveStatic({ path: "./dist/web/index.html" }));
  app.get("/watch/*", serveStatic({ path: "./dist/web/index.html" }));
}
const worker = setInterval(() => {
  try {
    expireCampaigns(db);
    processSimulationJobs(db);
  } catch (error) {
    console.error(
      "Simulation worker failed",
      error instanceof Error ? error.message : "unknown",
    );
  }
}, 2000);
const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  () =>
    console.log(
      `Live Studio API ready at http://${config.host}:${config.port}; payment=simulation; copilot=grounded-rules`,
    ),
);
const shutdown = () => {
  clearInterval(worker);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
