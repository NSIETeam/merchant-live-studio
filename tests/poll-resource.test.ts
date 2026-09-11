import test from "node:test";
import assert from "node:assert/strict";
import { pollResource } from "../src/web/poll-resource.js";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("polling serializes reads, expires hung requests and ignores late results", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending: { resolve: (value: string) => void; signal: AbortSignal }[] =
    [];
  const values: string[] = [],
    errors: Error[] = [];
  const polling = pollResource({
    read: (signal) =>
      new Promise<string>((resolve) => pending.push({ resolve, signal })),
    onValue: (value) => values.push(value),
    onError: (error) => errors.push(error),
    intervalMs: 5000,
    timeoutMs: 8000,
  });
  try {
    await flush();
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(pending.length, 1);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(errors.length, 1);
    assert.equal(pending[0].signal.aborted, true);
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(pending.length, 2);
    pending[1].resolve("revoked");
    await flush();
    pending[0].resolve("approved but old");
    await flush();
    assert.deepEqual(values, ["revoked"]);
    assert.equal(errors.length, 1);
  } finally {
    polling.stop();
  }
});

test("pausing and switching away cancel updates, while resuming reads afresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending: { resolve: (value: number) => void; signal: AbortSignal }[] =
    [];
  const values: number[] = [];
  const polling = pollResource({
    read: (signal) =>
      new Promise<number>((resolve) => pending.push({ resolve, signal })),
    onValue: (value) => values.push(value),
    onError: () => assert.fail("unexpected error"),
    intervalMs: 5000,
    timeoutMs: 8000,
  });
  await flush();
  polling.pause();
  pending[0].resolve(1);
  await flush();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(pending.length, 1);
  assert.deepEqual(values, []);
  assert.equal(pending[0].signal.aborted, true);
  polling.refresh();
  await flush();
  pending[1].resolve(2);
  await flush();
  assert.deepEqual(values, [2]);
  polling.refresh();
  await flush();
  polling.stop();
  pending[2].resolve(3);
  await flush();
  t.mock.timers.tick(60000);
  await flush();
  assert.deepEqual(values, [2]);
  assert.equal(pending.length, 3);
});
