import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { createStudio } from "../composition/studio.js";
import { loadConfig } from "../platform/infrastructure/public.js";
import { openDatabase } from "./db.js";
const config = loadConfig();
const db = openDatabase(config.databasePath);
const studio = createStudio(db, config);
if (config.demoMode) studio.seedDemo();
const app = studio.app;
if (existsSync("dist/web/index.html")) {
  app.get("/assets/*", serveStatic({ root: "./dist/web" }));
  app.get("/brand/*", serveStatic({ root: "./dist/web" }));
  app.get("/", serveStatic({ path: "./dist/web/index.html" }));
  app.get("/watch/*", serveStatic({ path: "./dist/web/index.html" }));
}
const worker = setInterval(() => {
  try {
    studio.tick();
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
      `Live Studio API ready at http://${config.host}:${config.port}; payment=simulation; agent=separate-service`,
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
