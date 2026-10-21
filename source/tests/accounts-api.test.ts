import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { createApp } from "../src/composition/studio.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { createAccessSecret } from "../src/platform/identity/credentials.js";

test("owner creates and resets scoped accounts once, manages access, and never rereads issued secrets", async () => {
  const db = openDatabase(":memory:"),
    token = createAccessSecret();
  const app = createApp(
    db,
    loadConfig({
      DEMO_MODE: "false",
      MERCHANT_CREDENTIALS: JSON.stringify({ owner: token, foreign: token }),
    }),
  );
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) {
    const r = await app.request("/api" + path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: r.status,
      data: (await r.json()) as any,
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
      cache: r.headers.get("cache-control"),
    };
  }
  try {
    const owner = (
      await call("/auth/merchant", "POST", { merchantId: "owner", token })
    ).cookie;
    const foreign = (
      await call("/auth/merchant", "POST", { merchantId: "foreign", token })
    ).cookie;
    const body = {
      actorId: "new-member",
      role: "presenter",
      requestKey: crypto.randomUUID(),
    };
    const pair = await Promise.all([
      call("/merchant/team/accounts", "POST", body, owner),
      call("/merchant/team/accounts", "POST", body, owner),
    ]);
    const fresh = pair.find((r) => r.data.secret)!,
      replay = pair.find((r) => r.data.replayed)!;
    assert.equal(fresh.status, 201);
    assert.equal(fresh.cache, "no-store");
    assert.equal(replay.status, 200);
    assert.equal(replay.data.secret, undefined);
    assert.equal(
      (
        await call(
          "/merchant/team/accounts",
          "POST",
          { ...body, role: "editor" },
          owner,
        )
      ).status,
      409,
    );
    const login = await call("/auth/merchant", "POST", {
      merchantId: "new-member",
      token: fresh.data.secret,
    });
    assert.equal(login.status, 200);
    assert.equal(
      (
        await call(
          "/merchant/team/accounts",
          "POST",
          { ...body, actorId: "intruder", requestKey: crypto.randomUUID() },
          login.cookie,
        )
      ).status,
      403,
    );
    const listed = (await call("/merchant/team", "GET", undefined, owner)).data
      .members;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].managed, true);
    assert.equal(listed[0].credentialVersion, 1);
    assert.equal(JSON.stringify(listed).includes(fresh.data.secret), false);
    const business = {
      name: "合成测试企业",
      creditCode: "91310100MA12345678",
      address: "合成测试地址",
      contact: "测试联系 00000000",
      licenses: "合成测试许可说明",
    };
    assert.equal(
      (
        await call(
          "/merchant/disclosure",
          "POST",
          {
            previousVersion: 0,
            data: {
              operator: business,
              seller: business,
              validThrough: "2099-12-31",
              complaintContact: "测试售后联系方式",
            },
            evidenceReference: "private-test-evidence",
          },
          owner,
        )
      ).status,
      201,
    );
    const approval = {
      action: "publish",
      note: "托管审核账号权限闭环测试。",
      acknowledged: true,
    };
    assert.equal(
      (
        await call(
          "/merchant/disclosure/1/review",
          "POST",
          approval,
          login.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/merchant/team/new-member",
          "PUT",
          {
            disabled: false,
            role: "reviewer",
            version: 0,
            reason: "调整为独立内容审核人员",
          },
          owner,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("/merchant/rooms", "GET", undefined, login.cookie)).status,
      401,
    );
    const reviewer = await call("/auth/merchant", "POST", {
      merchantId: "new-member",
      token: fresh.data.secret,
    });
    assert.equal(reviewer.status, 200);
    assert.equal(reviewer.data.memberRole, "reviewer");
    assert.equal(reviewer.data.requiresIndependentReview, true);
    assert.equal(
      (
        await call(
          "/merchant/disclosure/1/review",
          "POST",
          approval,
          reviewer.cookie,
        )
      ).status,
      200,
    );
    const reset = { expectedVersion: 1, requestKey: crypto.randomUUID() };
    const path = "/merchant/team/accounts/new-member/reset";
    assert.equal((await call(path, "POST", reset, foreign)).status, 404);
    const rotated = await call(path, "POST", reset, owner);
    assert.equal(rotated.status, 200);
    assert.equal(rotated.data.credentialVersion, 2);
    assert.equal(
      (await call(path, "POST", reset, owner)).data.secret,
      undefined,
    );
    assert.equal(
      (
        await call(
          path,
          "POST",
          { ...reset, requestKey: crypto.randomUUID() },
          owner,
        )
      ).status,
      409,
    );
    assert.equal(
      (await call("/merchant/rooms", "GET", undefined, login.cookie)).status,
      401,
    );
    assert.equal(
      (
        await call("/auth/merchant", "POST", {
          merchantId: "new-member",
          token: fresh.data.secret,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/auth/merchant", "POST", {
          merchantId: "new-member",
          token: rotated.data.secret,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          "/merchant/team/new-member",
          "PUT",
          { disabled: true, version: 1, reason: "测试停用新开户成员" },
          owner,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call("/auth/merchant", "POST", {
          merchantId: "new-member",
          token: rotated.data.secret,
        })
      ).status,
      401,
    );
    for (const actorId of ["owner", "foreign", "demo"])
      assert.equal(
        (
          await call(
            "/merchant/team/accounts",
            "POST",
            { ...body, actorId, requestKey: crypto.randomUUID() },
            owner,
          )
        ).status,
        409,
      );
    for (const actorId of ["__proto__", "constructor", "toString"])
      assert.equal(
        (
          await call(
            "/merchant/team/accounts",
            "POST",
            { ...body, actorId, requestKey: crypto.randomUUID() },
            owner,
          )
        ).status,
        400,
      );
    for (const merchantId of ["__proto__", "constructor", "toString"])
      assert.equal(
        (await call("/auth/merchant", "POST", { merchantId, token })).status,
        401,
      );
    assert.equal(
      (await call("/merchant/team/accounts", "POST", body)).status,
      401,
    );
  } finally {
    db.close();
  }
});
