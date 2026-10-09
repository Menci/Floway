import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

test('Bash Pi protects a reused settings stage before the JSONC subprocess writes', () => {
  const directory = mkdtempSync(join(packageRoot, '.pi-stage-protection-test-'));
  try {
    const settings = join(directory, 'settings.json');
    const original = '{ "untouched": "private-setting" }';
    writeFileSync(settings, original);
    const executable = join(directory, 'node');
    writeFileSync(executable, `#!/bin/sh\n${quote(process.execPath)} -e 'const mode = require("node:fs").statSync(process.env.PI_STAGE_TEST_PATH).mode & 511; if (mode !== 384) { console.error("unprotected stage mode " + mode.toString(8) + " before write"); process.exit(73); }' || exit $?\nexec ${quote(process.execPath)} "$@"\n`);
    chmodSync(executable, 0o700);
    const script = [
      'set +e; main() { :; }; out_error() { echo "$*" >&2; };',
      `source ${quote(join(packageRoot, 'installers/bash/pi.sh'))};`,
      `PI_SETTINGS_PATH=${quote(settings)}; SETUP_TMPDIR=${quote(directory)}; SETUP_PI_PROVIDER=floway; SETUP_PI_MODEL=; SETUP_PI_THINKING_LEVEL=; SETUP_PI_RETRY_ENABLED=; SETUP_PI_MAX_RETRIES=;`,
      'export PI_STAGE_TEST_PATH="$PI_SETTINGS_PATH.floway-stage.$$"; : > "$PI_STAGE_TEST_PATH"; chmod 644 "$PI_STAGE_TEST_PATH";',
      `_write_jsonc_editor() { cp ${quote(join(packageRoot, 'installers/node/jsonc-edit.mjs'))} "$SETUP_TMPDIR/jsonc-edit.mjs"; };`,
      'pi_stage_settings || exit $?; cat "$PI_SETTINGS_STAGE";',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toBe(original);
    expect(readFileSync(settings, 'utf8')).toBe(original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
