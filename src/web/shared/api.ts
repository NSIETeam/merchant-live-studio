export const AUTH_REQUIRED_EVENT = "kaopu:auth-required";

function notifyAuthenticationRequired() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  }
}

function basePath() {
  return (
    (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env
      ?.BASE_URL || "/"
  );
}

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${basePath()}api${path}`, {
      method,
      signal: options?.signal,
      credentials: "same-origin",
      headers:
        body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("网络连接暂时不可用，请检查网络后重试。");
  }
  if (res.status === 401) notifyAuthenticationRequired();
  const fallback =
    res.status === 401
      ? "登录状态已失效，请重新登录。"
      : res.status === 403
        ? "没有权限执行此操作，请确认当前账号。"
        : res.status === 429
          ? "请求较频繁，请稍后重试。"
          : res.status >= 500
            ? "服务暂时不可用，请稍后重试。"
            : res.ok
              ? "服务暂未返回有效结果，请稍后重试。"
              : "请求未完成，请刷新页面后重试。";
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(fallback);
  }
  if (!res.ok) {
    const businessError =
      data && typeof data === "object" && "error" in data
        ? data.error
        : undefined;
    throw new Error(
      typeof businessError === "string" &&
        businessError.trim() &&
        !/<(?:!doctype|html|head|body)\b/i.test(businessError)
        ? businessError
        : fallback,
    );
  }
  return data as T;
}
export const money = (cents: number) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(
    cents / 100,
  );
export const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
