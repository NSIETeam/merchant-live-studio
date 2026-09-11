import assert from "node:assert/strict";
import test from "node:test";
import { api, AUTH_REQUIRED_EVENT } from "../src/web/shared/api.js";

test("a 401 response tells the merchant shell to leave stale authenticated UI", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  let eventName = "";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent(event: Event) {
        eventName = event.type;
        return true;
      },
    },
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "请先登录商家工作台" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });

  try {
    await assert.rejects(api("/merchant/rooms"), /请先登录商家工作台/);
    assert.equal(eventName, AUTH_REQUIRED_EVENT);
  } finally {
    globalThis.fetch = previousFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }
});

test("authorization failures do not discard a valid merchant session", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  let eventCount = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent() {
        eventCount += 1;
        return true;
      },
    },
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "没有权限执行此操作" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });

  try {
    await assert.rejects(api("/merchant/team"), /没有权限/);
    assert.equal(eventCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }
});
