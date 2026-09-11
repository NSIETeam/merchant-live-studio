import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransferStore } from "../src/modules/payments/public.js";
import { openDatabase } from "../src/server/db.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

function fixture() {
  const db = openDatabase(
    join(mkdtempSync(join(tmpdir(), "kaopu-payment-store-")), "studio.sqlite"),
  );
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
  return { db, store: createTransferStore(db) };
}

test("transfer store queues one immutable claim order and records monotonic recovery states", () => {
  const { db, store } = fixture();
  try {
    const input = {
      outBillNo: "Bill202609120001",
      claimId: "claim-a",
      campaignId: "campaign",
      merchantId: "merchant",
      recipientDigest: digestA,
      amountCents: 50,
    };
    const queued = store.queue(input, 10);
    assert.equal(queued.replayed, false);
    assert.equal(queued.transfer.state, "queued");
    assert.equal(store.queue(input, 11).replayed, true);
    assert.throws(() => store.queue({ ...input, amountCents: 51 }, 12));
    assert.throws(() =>
      store.queue(
        { ...input, outBillNo: "Bill202609120002", amountCents: 51 },
        12,
      ),
    );

    assert.equal(
      store.markCreateAttempt(input.outBillNo, 20).state,
      "create_unknown",
    );
    assert.equal(
      store.markCreateAttempt(input.outBillNo, 21).state,
      "create_unknown",
    );
    const waiting = store.applyReceipt(
      input.outBillNo,
      {
        outBillNo: input.outBillNo,
        state: "wait_user_confirm",
        providerId: "provider-bill-a",
        confirmationPackage: "opaque-confirmation-package",
      },
      "create",
      30,
    );
    assert.equal(waiting.state, "wait_user_confirm");
    assert.equal(waiting.confirmationPackage, "opaque-confirmation-package");
    const paid = store.applyReceipt(
      input.outBillNo,
      {
        outBillNo: input.outBillNo,
        state: "paid",
        providerId: "provider-bill-a",
      },
      "query",
      40,
    );
    assert.equal(paid.state, "paid");
    assert.equal(paid.confirmationPackage, null);
    assert.throws(() =>
      store.applyReceipt(
        input.outBillNo,
        { outBillNo: input.outBillNo, state: "pending" },
        "query",
        50,
      ),
    );
    assert.throws(() =>
      store.applyReceipt(
        input.outBillNo,
        {
          outBillNo: input.outBillNo,
          state: "paid",
          providerId: "different-provider-bill",
        },
        "query",
        50,
      ),
    );
    assert.deepEqual(
      store.events(input.outBillNo).map((event: any) => event.state),
      ["queued", "create_unknown", "wait_user_confirm", "paid"],
    );
    assert.throws(() => db.exec("DELETE FROM payment_transfer_events"));
  } finally {
    db.close();
  }
});

test("verified terminal notifications are idempotent and cannot alter another transfer", () => {
  const { db, store } = fixture();
  try {
    store.queue(
      {
        outBillNo: "Bill202609120002",
        claimId: "claim-b",
        campaignId: "campaign",
        merchantId: "merchant",
        recipientDigest: digestB,
        amountCents: 50,
      },
      10,
    );
    store.markCreateAttempt("Bill202609120002", 20);
    store.applyReceipt(
      "Bill202609120002",
      {
        outBillNo: "Bill202609120002",
        state: "pending",
        providerId: "provider-bill-b",
      },
      "create",
      30,
    );
    const event = {
      eventId: "EV-202609120002",
      merchantId: "merchant",
      amountCents: 50,
      verifiedRecipientId: "never-persisted-openid",
      receipt: {
        outBillNo: "Bill202609120002",
        state: "paid" as const,
        providerId: "provider-bill-b",
      },
    };
    const first = store.applyNotification(event, digestA, digestB, 40);
    assert.equal(first.replayed, false);
    assert.equal(first.transfer.state, "paid");
    const replay = store.applyNotification(event, digestA, digestB, 41);
    assert.equal(replay.replayed, true);
    assert.equal(
      store
        .events("Bill202609120002")
        .filter((item: any) => item.source === "notify").length,
      1,
    );
    assert.throws(() =>
      store.applyNotification(event, "c".repeat(64), digestB, 42),
    );
    assert.throws(() =>
      store.applyNotification(
        { ...event, eventId: "EV-wrong-amount", amountCents: 51 },
        digestA,
        digestB,
        42,
      ),
    );
    assert.throws(() =>
      store.applyNotification(
        { ...event, eventId: "EV-wrong-recipient" },
        digestA,
        digestA,
        42,
      ),
    );
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM payment_notification_receipts")
        .get()!.n,
      1,
    );
    assert.throws(() =>
      db.exec("UPDATE payment_notification_receipts SET payload_sha256='x'"),
    );
  } finally {
    db.close();
  }
});

test("schema v24 migrates payment state without changing existing claims", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "kaopu-payment-migration-")),
    "studio.sqlite",
  );
  const db = openDatabase(path);
  db.prepare(
    `INSERT INTO rooms(id,merchant_id,title,product_name,stream_secret,created_at)
     VALUES('room','merchant','test','test','secret',1)`,
  ).run();
  db.prepare(
    `INSERT INTO campaigns(
      id,room_id,total_cents,count,remaining_cents,remaining_count,min_watch_seconds,opens_at,expires_at
    ) VALUES('campaign','room',10,1,10,1,0,1,9999999999999)`,
  ).run();
  db.prepare(
    `INSERT INTO claims(id,campaign_id,viewer_id,amount_cents,status,created_at)
     VALUES('legacy-claim','campaign','legacy-viewer',10,'reserved',2)`,
  ).run();
  db.exec(
    "ALTER TABLE campaigns DROP COLUMN payment_mode; DELETE FROM schema_migrations WHERE version>=25",
  );
  db.exec("DROP TABLE wechat_recipient_authorization_events");
  db.exec("DROP TABLE payment_notification_receipts");
  db.exec("DROP TABLE payment_transfer_events");
  db.exec("DROP TABLE payment_transfers");
  db.close();
  const migrated = openDatabase(path);
  try {
    assert.equal(
      migrated
        .prepare("SELECT status FROM claims WHERE id='legacy-claim'")
        .get()!.status,
      "reserved",
    );
    assert.equal(
      migrated.prepare("SELECT max(version) AS v FROM schema_migrations").get()!
        .v,
      27,
    );
    assert.equal(
      migrated.prepare("SELECT count(*) AS n FROM payment_transfers").get()!.n,
      0,
    );
  } finally {
    migrated.close();
  }
});
