import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWeChatRecipientVault } from "../src/platform/identity/public.js";
import { openDatabase } from "../src/server/db.js";

test("recipient vault requires fresh explicit authorization and never stores plaintext OpenID", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "kaopu-recipient-vault-")),
    "studio.sqlite",
  );
  const db = openDatabase(path);
  let now = 1_800_000_000_000;
  let nonce = 0;
  const key = "42".repeat(32);
  const subject = "oExample_OpenId-001";
  const vault = createWeChatRecipientVault(
    db,
    key,
    () => now,
    (size) => Buffer.alloc(size, ++nonce),
  );
  try {
    assert.deepEqual(vault.status("viewer-a", "merchant-a"), {
      authorized: false,
      authorizedAt: null,
      staged: false,
    });
    assert.throws(() => vault.authorize("viewer-a", "merchant-a"));
    vault.stage("viewer-a", "merchant-a", subject);
    assert.equal(vault.status("viewer-a", "merchant-a").staged, true);
    const authorized = vault.authorize("viewer-a", "merchant-a");
    assert.equal(authorized.authorized, true);
    assert.equal(authorized.replayed, false);
    assert.match(authorized.recipientDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(vault.resolve("viewer-a", "merchant-a"), {
      subject,
      recipientDigest: authorized.recipientDigest,
    });
    const stored = db
      .prepare(
        `SELECT recipient_ciphertext AS ciphertext,recipient_digest AS digest
         FROM wechat_recipient_authorization_events ORDER BY id DESC LIMIT 1`,
      )
      .get() as { ciphertext: string; digest: string };
    assert.equal(stored.ciphertext.includes(subject), false);
    assert.equal(stored.digest.includes(subject), false);
    assert.equal(
      JSON.stringify(
        db.prepare("SELECT * FROM wechat_recipient_authorization_events").all(),
      ).includes(subject),
      false,
    );

    vault.stage("viewer-a", "merchant-a", subject);
    assert.equal(vault.authorize("viewer-a", "merchant-a").replayed, true);
    vault.revoke("viewer-a", "merchant-a");
    assert.equal(vault.resolve("viewer-a", "merchant-a"), null);
    assert.equal(vault.status("viewer-a", "merchant-a").authorized, false);
    assert.throws(() =>
      db.exec("DELETE FROM wechat_recipient_authorization_events"),
    );
  } finally {
    db.close();
  }
});

test("recipient staging is tenant-bound, short-lived, and ciphertext is bound to its owner", () => {
  const db = openDatabase(":memory:");
  let now = 1_800_000_000_000;
  let nonce = 10;
  const vault = createWeChatRecipientVault(
    db,
    "24".repeat(32),
    () => now,
    (size) => Buffer.alloc(size, ++nonce),
  );
  try {
    vault.stage("viewer-a", "merchant-a", "oExample_OpenId-001");
    assert.throws(() => vault.authorize("viewer-a", "merchant-b"));
    now += 15 * 60 * 1000;
    assert.throws(() => vault.authorize("viewer-a", "merchant-a"));
    vault.stage("viewer-a", "merchant-a", "oExample_OpenId-001");
    vault.authorize("viewer-a", "merchant-a");
    const ciphertext = db
      .prepare(
        `SELECT recipient_ciphertext AS value
         FROM wechat_recipient_authorization_events WHERE state='authorized'`,
      )
      .get()!.value;
    db.prepare(
      `INSERT INTO wechat_recipient_authorization_events(
        viewer_id,merchant_id,state,recipient_ciphertext,recipient_digest,created_at
      ) SELECT 'viewer-b',merchant_id,state,recipient_ciphertext,recipient_digest,created_at
        FROM wechat_recipient_authorization_events WHERE state='authorized'`,
    ).run();
    assert.equal(typeof ciphertext, "string");
    assert.throws(() => vault.resolve("viewer-b", "merchant-a"));
  } finally {
    db.close();
  }
});

test("recipient vault rejects weak keys and malformed subjects", () => {
  const db = openDatabase(":memory:");
  try {
    assert.throws(() => createWeChatRecipientVault(db, "short"));
    const vault = createWeChatRecipientVault(db, "11".repeat(32));
    assert.throws(() => vault.stage("viewer", "merchant", "bad open id"));
  } finally {
    db.close();
  }
});
