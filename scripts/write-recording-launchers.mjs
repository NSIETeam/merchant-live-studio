import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function writeRecordingLaunchers(root = resolve('dist/server')) {
  const names = ['recording-hook', 'recording-audit-cli', 'recording-backup-cli'];
  // Validate all targets before modifying any compatibility entry point.
  for (const name of names) await access(join(root, 'composition', `${name}.js`));
  await mkdir(join(root, 'server'), { recursive: true });
  for (const name of names) {
    await writeFile(join(root, 'server', `${name}.js`),
      `// Compatibility entry point for existing MediaMTX and operator commands.\nimport '../composition/${name}.js';\n`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await writeRecordingLaunchers();
}
