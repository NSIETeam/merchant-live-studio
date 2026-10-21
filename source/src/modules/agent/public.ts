import { createAgentService, type AgentServiceOptions } from "./app.js";
import { loadAgentConfig, type AgentConfig } from "./config.js";
import { openAgentDatabase } from "./persistence/database.js";

export type { AgentServiceOptions } from "./app.js";
export { loadAgentConfig } from "./config.js";
export type { AgentConfig } from "./config.js";

/** Own the database lifetime; callers only receive the Agent's service API. */
export function createAgentRuntime(
  config: AgentConfig = loadAgentConfig(),
  options: AgentServiceOptions = {},
) {
  const db = openAgentDatabase(config.databasePath);
  try {
    const service = createAgentService(db, config, options);
    let closing: Promise<void> | undefined;
    return {
      app: service.app,
      start: service.start,
      status: service.status,
      close() {
        closing ??= service.close().then(() => {
          db.close();
        });
        return closing;
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
