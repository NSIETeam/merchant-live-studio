import test from "node:test";
import assert from "node:assert/strict";
import {
  createTransferStore,
  createTransferWorker,
} from "../src/modules/payments/public.js";
import type {
  PaymentProvider,
  TransferReceipt,
} from "../src/modules/payments/public.js";
import { openDatabase } from "../src/server/db.js";

function fixture() {
  const db = openDatabase(":memory:");
  db.prepare(
    `INSERT INTO rooms(id,merchant_id,title,product_name,stream_secret,created_at)
     VALUES('room','merchant','test','test','secret',1)`,
  ).run();
  db.prepare(
    `INSERT INTO campaigns(
      id,room_id,total_cents,count,remaining_cents,remaining_count,min_watch_seconds,opens_at,expires_at
    ) VALUES('campaign','room',100,2,100,2,0,1,9999999999999)`,
  ).run();
  db.prepare(
    `INSERT INTO claims(id,campaign_id,viewer_id,amount_cents,status,created_at)
     VALUES('claim-a','campaign','viewer-a',50,'reserved',2),
           ('claim-b','campaign','viewer-b',50,'reserved',3)`,
  ).run();
  const store = createTransferStore(db);
  const queue = (claimId: string, outBillNo: string, digest: string) =>
    store.queue(
      {
        outBillNo,
        claimId,
        campaignId: "campaign",
        merchantId: "merchant",
        recipientDigest: digest,
        amountCents: 50,
      },
      10,
    );
  return { db, store, queue };
}

function provider(
  create: (request: any) => Promise<TransferReceipt>,
  query: (merchantId: string, outBillNo: string) => Promise<TransferReceipt>,
): PaymentProvider {
  return {
    createTransfer: create,
    queryTransfer: query,
    async verifyAndDecodeNotification() {
      throw new Error("not used");
    },
  };
}

test("worker creates once, then queries the same bill until a verified terminal result", async () => {
  const { db, store, queue } = fixture();
  let now = 100;
  let creates = 0;
  let queries = 0;
  const digest = "a".repeat(64);
  queue("claim-a", "Bill202609120001", digest);
  const worker = createTransferWorker(
    store,
    provider(
      async (request) => {
        creates++;
        assert.deepEqual(request, {
          merchantId: "merchant",
          outBillNo: "Bill202609120001",
          amountCents: 50,
          verifiedRecipientId: "oExample_OpenId-001",
        });
        return {
          outBillNo: request.outBillNo,
          state: "pending",
          providerId: "provider-bill-a",
        };
      },
      async (_merchantId, outBillNo) => {
        queries++;
        return {
          outBillNo,
          state: "paid",
          providerId: "provider-bill-a",
        };
      },
    ),
    () => ({ subject: "oExample_OpenId-001", recipientDigest: digest }),
    () => now,
  );
  try {
    assert.deepEqual(await worker.process(), {
      examined: 1,
      advanced: 1,
      deferred: 0,
    });
    assert.equal(store.byClaim("claim-a")!.state, "pending");
    assert.equal(store.byClaim("claim-a")!.attempts, 1);
    assert.equal(creates, 1);
    assert.equal(queries, 0);
    assert.equal((await worker.process()).examined, 0);
    now += 30_001;
    assert.equal((await worker.process()).advanced, 1);
    assert.equal(store.byClaim("claim-a")!.state, "paid");
    assert.equal(store.byClaim("claim-a")!.attempts, 2);
    assert.equal(creates, 1);
    assert.equal(queries, 1);
  } finally {
    db.close();
  }
});

test("worker recovers an interrupted create by querying and never creates a second bill", async () => {
  const { db, store, queue } = fixture();
  let now = 100;
  const digest = "b".repeat(64);
  queue("claim-b", "Bill202609120002", digest);
  store.markCreateAttempt("Bill202609120002", now);
  now += 5_001;
  let queried = 0;
  const worker = createTransferWorker(
    store,
    provider(
      async () => {
        throw new Error("create must never be retried after an unknown result");
      },
      async (_merchantId, outBillNo) => {
        queried++;
        return { outBillNo, state: "cancelled", providerId: "provider-bill-b" };
      },
    ),
    () => ({ subject: "oExample_OpenId-002", recipientDigest: digest }),
    () => now,
  );
  try {
    assert.equal((await worker.process()).advanced, 1);
    assert.equal(queried, 1);
    assert.equal(store.byClaim("claim-b")!.state, "cancelled");
  } finally {
    db.close();
  }
});

test("worker serializes local runs and backs off missing recipients or provider failures", async () => {
  const { db, store, queue } = fixture();
  let now = 100;
  const digest = "c".repeat(64);
  queue("claim-a", "Bill202609120003", digest);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let available = false;
  const worker = createTransferWorker(
    store,
    provider(
      async (request) => {
        await gate;
        throw new Error(`upstream failed for ${request.outBillNo}`);
      },
      async (_merchantId, outBillNo) => ({ outBillNo, state: "pending" }),
    ),
    () =>
      available
        ? { subject: "oExample_OpenId-003", recipientDigest: digest }
        : null,
    () => now,
  );
  try {
    assert.deepEqual(await worker.process(), {
      examined: 1,
      advanced: 0,
      deferred: 1,
    });
    assert.equal(store.byClaim("claim-a")!.state, "queued");
    assert.equal(
      store.byClaim("claim-a")!.lastErrorCode,
      "recipient_unavailable",
    );
    now = store.byClaim("claim-a")!.nextAttemptAt;
    available = true;
    const first = worker.process();
    const second = worker.process();
    assert.equal(first, second);
    release();
    assert.equal((await first).deferred, 1);
    const after = store.byClaim("claim-a")!;
    assert.equal(after.state, "create_unknown");
    assert.equal(after.lastErrorCode, "provider_or_state_error");
    assert.ok(after.nextAttemptAt > now);
    assert.equal(JSON.stringify(after).includes("upstream failed"), false);
  } finally {
    db.close();
  }
});
