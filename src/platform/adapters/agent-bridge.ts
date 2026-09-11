import { HTTPException } from "hono/http-exception";
import type { AgentServiceStatus } from "../../shared/agent.js";
import type { Config } from "../infrastructure/public.js";

export interface AgentBridge {
  request<T>(
    tenant: string,
    path: string,
    method?: string,
    body?: unknown,
  ): Promise<T>;
  status(): Promise<AgentServiceStatus>;
}

// HTTP is the only production dependency on the Agent module. No Agent database,
// prompt implementation, model credential, or model SDK is loaded by Live Core.
export class HttpAgentBridge implements AgentBridge {
  constructor(
    private config: Config,
    private transport: (
      url: string,
      init: RequestInit,
    ) => Promise<Response> = fetch,
  ) {}

  async request<T>(
    tenant: string,
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    if (!this.config.agentServiceUrl)
      throw new HTTPException(503, {
        message: "Agent 服务尚未连接；直播和红包仍可使用。",
      });
    let response: Response;
    try {
      response = await this.transport(`${this.config.agentServiceUrl}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(path === "/health" ? 1500 : 5000),
        headers: {
          authorization: `Bearer ${this.config.agentServiceToken}`,
          "x-studio-tenant": tenant,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new HTTPException(503, {
        message: "Agent 暂时离线或繁忙；直播和红包仍可使用。",
      });
    }
    if (!response.ok) {
      // Never expose the internal URL, service credentials, or provider errors.
      const status = response.status;
      const message =
        status === 429
          ? "Agent 任务较多，请稍后再试。"
          : status === 404
            ? "Agent 记录不存在。"
            : status === 409
              ? "版本或任务状态已变化，请刷新后重试。"
              : status === 400
                ? "Agent 请求内容不完整或超出限制，请检查后重试。"
                : "Agent 服务暂时不可用；直播和红包仍可使用。";
      throw new HTTPException(
        [400, 404, 409, 429].includes(status)
          ? (status as 400 | 404 | 409 | 429)
          : 503,
        { message },
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new HTTPException(503, {
        message: "Agent 返回了无法读取的结果，请稍后重试。",
      });
    }
  }

  async status(): Promise<AgentServiceStatus> {
    try {
      const result = await this.request<AgentServiceStatus>(
        "system",
        "/health",
      );
      return {
        available: true,
        modelConfigured: result.modelConfigured === true,
        provider:
          result.provider === "remote-model"
            ? "remote-model"
            : "grounded-rules",
        queued: Number(result.queued) || 0,
        running: Number(result.running) || 0,
        maxConcurrency: Number(result.maxConcurrency) || 0,
      };
    } catch {
      return {
        available: false,
        modelConfigured: false,
        provider: "grounded-rules",
        queued: 0,
        running: 0,
        maxConcurrency: 0,
        message: "Agent 服务未连接，直播底座独立运行。",
      };
    }
  }
}
