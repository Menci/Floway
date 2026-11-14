import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parse } from 'jsonc-parser';
import { expect, test } from 'vitest';

const execute = promisify(execFile);
// Exercise the runtime and bundler shipped with the project's Wrangler dependency.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));

test('Cloudflare codecs preserve responses, cancellation, and errors in the pinned workerd', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-codec-workerd-'));
  try {
    const config = parse(await readFile(new URL('../../../wrangler.example.jsonc', import.meta.url), 'utf8')) as {
      compatibility_date: string;
      compatibility_flags: string[];
    };
    await execute(wranglerRequire.resolve('esbuild/bin/esbuild'), [
      fileURLToPath(new URL('./test-utils/http-content-decoders-worker.ts', import.meta.url)),
      '--bundle', '--format=esm', '--platform=node', `--outfile=${join(directory, 'worker.js')}`,
    ]);
    const configPath = join(directory, 'config.capnp');
    await writeFile(configPath, `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "codecs", worker = (
    compatibilityDate = ${JSON.stringify(config.compatibility_date)},
    compatibilityFlags = ${JSON.stringify(config.compatibility_flags)},
    modules = [(name = "worker.js", esModule = embed "worker.js")]
  ))]
);
`);
    const { stdout, stderr } = await execute(wranglerRequire.resolve('workerd/bin/workerd'), ['test', configPath], { timeout: 30_000 });
    const output = stdout + stderr;
    expect(output.match(/\[ PASS \]/g)).toHaveLength(13);
    expect(output).not.toContain('[ FAIL ]');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
