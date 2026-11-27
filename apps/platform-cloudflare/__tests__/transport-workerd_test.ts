import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parse } from 'jsonc-parser';
import { expect, test } from 'vitest';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));

test('native fetch and socket cancellation preserve the causal transport outcome in workerd', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-transport-workerd-'));
  let interrupted: http.ServerResponse | undefined;
  const headReceived = Promise.withResolvers<void>();
  const server = http.createServer((request, response) => {
    if (request.url === '/head') {
      headReceived.resolve();
    } else if (request.url === '/observed-head') {
      void headReceived.promise.then(() => response.end());
    } else if (request.url === '/drop') {
      interrupted?.destroy();
      response.end();
    } else if (request.url === '/upload') {
      const length = request.headers['content-length'];
      if (length !== undefined) response.setHeader('x-observed-length', length);
      request.pipe(response);
    } else if (request.url === '/duplex-upload') {
      request.once('data', () => {
        response.writeHead(200, { 'content-length': '2' });
        response.write('a');
      });
      request.once('end', () => response.end('b'));
    } else {
      response.writeHead(200, { 'content-length': '20' });
      response.write('prefix');
      if (request.url === '/loss') interrupted = response;
    }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a loopback HTTP address');
    const origin = `http://127.0.0.1:${address.port}`;
    const config = parse(await readFile(new URL('../../../wrangler.example.jsonc', import.meta.url), 'utf8')) as {
      compatibility_date: string;
      compatibility_flags: string[];
    };
    await execute(wranglerRequire.resolve('esbuild/bin/esbuild'), [
      fileURLToPath(new URL('./test-utils/transport-worker.ts', import.meta.url)),
      '--bundle', '--format=esm', '--platform=node', '--external:cloudflare:*', `--outfile=${join(directory, 'worker.js')}`,
    ]);
    const configPath = join(directory, 'config.capnp');
    await writeFile(configPath, `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "internet", network = (allow = ["127.0.0.1/32"])),
    (name = "transport", worker = (
      compatibilityDate = ${JSON.stringify(config.compatibility_date)},
      compatibilityFlags = ${JSON.stringify(config.compatibility_flags)},
      bindings = [(name = "ORIGIN", text = ${JSON.stringify(origin)})],
      modules = [(name = "worker.js", esModule = embed "worker.js")]
    ))
  ]
);
`);
    const { stdout, stderr } = await execute(wranglerRequire.resolve('workerd/bin/workerd'), ['test', configPath], { timeout: 10_000 });
    const output = stdout + stderr;
    expect(output.match(/\[ PASS \]/g)).toHaveLength(7);
    expect(output).not.toContain('[ FAIL ]');
    expect(output).not.toContain('uncaught exception');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
