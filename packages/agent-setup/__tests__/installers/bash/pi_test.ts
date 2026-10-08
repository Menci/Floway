import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

test.each([
  { output: 'upstream probe failure', code: 73, expected: 'upstream probe failure' },
  { output: '', code: 0, expected: 'Node.js returned an invalid version.' },
  { output: 'invalid.version', code: 0, expected: 'Node.js returned an invalid version.' },
])('Bash rejects failed or invalid required Node probes: $output', ({ output, code, expected }) => {
  const directory = mkdtempSync(join(packageRoot, '.pi-node-probe-test-'));
  try {
    const executable = join(directory, 'node');
    writeFileSync(executable, `#!/bin/sh\nprintf '%s' '${output}'${code === 0 ? '' : ' >&2'}\nexit ${code}\n`);
    chmodSync(executable, 0o700);
    const body = readFileSync(join(packageRoot, 'installers/bash/pi.sh'), 'utf8');
    const timeout = readFileSync(join(packageRoot, 'installers/bash/common/process.sh'), 'utf8');
    const script = [
      'set +e; out_error() { printf "%s\\n" "$*" >&2; };',
      timeout,
      body.slice(0, body.lastIndexOf("main 'Pi'")),
      `SETUP_TMPDIR=${quote(directory)}; pi_check_node; exit $?;`,
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
