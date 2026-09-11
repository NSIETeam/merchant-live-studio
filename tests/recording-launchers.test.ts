import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// Build tooling is JavaScript and intentionally outside the application graph.
// @ts-expect-error The build script has no TypeScript declaration.
import { writeRecordingLaunchers } from '../scripts/write-recording-launchers.mjs';
test('legacy recording commands execute new entry points and missing targets fail before writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recording-launchers-'));
  try {
    await mkdir(join(root, 'composition'));
    await mkdir(join(root, 'server'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(join(root, 'server', 'recording-hook.js'), 'unchanged');
    await assert.rejects(writeRecordingLaunchers(root));
    assert.equal(await readFile(join(root, 'server', 'recording-hook.js'), 'utf8'), 'unchanged');
    for (const name of ['recording-hook', 'recording-audit-cli', 'recording-backup-cli']) {
      await writeFile(join(root, 'composition', `${name}.js`), `console.log(${JSON.stringify(name)});`);
    }
    await writeRecordingLaunchers(root);
    for (const name of ['recording-hook', 'recording-audit-cli', 'recording-backup-cli']) {
      const result = spawnSync(process.execPath, [join(root, 'server', `${name}.js`)], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), name);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
