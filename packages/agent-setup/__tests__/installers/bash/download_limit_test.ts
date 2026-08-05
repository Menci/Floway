import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { SETUP_BASH_COMMON_CLI } from '../../../src/script-assets.generated.ts';

const functionStart = SETUP_BASH_COMMON_CLI.indexOf('_download_and_run_installer() {');
const functionEnd = SETUP_BASH_COMMON_CLI.indexOf('\n\n_discover_cli() {', functionStart);
if (functionStart < 0 || functionEnd < 0) throw new Error('could not locate _download_and_run_installer in the generated Bash installer');
const DOWNLOAD_INSTALLER = SETUP_BASH_COMMON_CLI.slice(functionStart, functionEnd);

test('Bash installer downloads stop at the byte limit before execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'floway-installer-size-limit.'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': '1025', 'content-type': 'text/x-shellscript' });
    response.end(`printf 'executed' > "$1"\n${'x'.repeat(995)}`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP address');

  try {
    const result = await new Promise<{ code: number; stderr: string }>(resolve => {
      const child = spawn('/bin/bash', ['-c', `
${DOWNLOAD_INSTALLER}
SETUP_TMPDIR=$1
AGENT_SETUP_TEST_DOWNLOAD_MAX_BYTES=1024
out_error() { printf '%s\\n' "$1" >&2; }
_run_with_timeout() { "$@"; }
_download_and_run_installer "$2"
`, 'download-limit-test', root, `http://127.0.0.1:${address.port}/installer.sh`]);
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code: code ?? -1, stderr }));
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('installer download exceeded the 8 MiB size limit');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
