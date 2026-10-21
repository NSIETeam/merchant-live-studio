import test from "node:test";
import assert from "node:assert/strict";
import { LocalCameraSession } from "../src/web/local-camera.js";
function fakeStream() {
  let stopped = 0;
  return {
    stream: {
      getTracks: () => [{ stop: () => stopped++ }],
    } as unknown as MediaStream,
    stopped: () => stopped,
  };
}
test("local preview requests video only and releases all owned tracks", async () => {
  const fake = fakeStream();
  let constraints: MediaStreamConstraints | undefined;
  const session = new LocalCameraSession(async (c) => {
    constraints = c;
    return fake.stream;
  });
  assert.equal(await session.start("environment"), fake.stream);
  assert.equal(constraints?.audio, false);
  assert.deepEqual((constraints?.video as MediaTrackConstraints).facingMode, {
    ideal: "environment",
  });
  session.stop();
  session.stop();
  assert.equal(fake.stopped(), 1);
});
test("cancelled or superseded permission requests cannot retain a camera stream", async () => {
  const resolvers: Array<(s: MediaStream) => void> = [];
  const session = new LocalCameraSession(
    () => new Promise((resolve) => resolvers.push(resolve)),
  );
  const pending = session.start("user");
  session.stop();
  const cancelled = fakeStream();
  resolvers[0](cancelled.stream);
  assert.equal(await pending, null);
  assert.equal(cancelled.stopped(), 1);
  const first = session.start("user"),
    second = session.start("environment");
  const old = fakeStream(),
    current = fakeStream();
  resolvers[2](current.stream);
  assert.equal(await second, current.stream);
  resolvers[1](old.stream);
  assert.equal(await first, null);
  assert.equal(old.stopped(), 1);
  assert.equal(current.stopped(), 0);
  session.stop();
  assert.equal(current.stopped(), 1);
});
test("obsolete permission rejection is ignored while current rejection is surfaced", async () => {
  let reject!: (e: Error) => void;
  const session = new LocalCameraSession(
    () =>
      new Promise((_r, j) => {
        reject = j;
      }),
  );
  const pending = session.start("user");
  session.stop();
  reject(new Error("denied"));
  assert.equal(await pending, null);
  const active = session.start("user");
  reject(new Error("denied"));
  await assert.rejects(active, /denied/);
});
