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

test('Bash Pi restores credentials after a later extension replacement fails', () => {
  const directory = mkdtempSync(join(packageRoot, '.pi-auth-rollback-test-'));
  try {
    const auth = '{"openai":{"type":"api_key","key":"other-key"},"floway":{"type":"api_key","key":"old-key"}}';
    writeFileSync(join(directory, 'auth.json'), auth);
    writeFileSync(join(directory, 'floway.js'), 'original extension');
    writeFileSync(join(directory, 'settings.json'), '{}');
    const connections = '{"connections":[{"provider":"floway","endpoint":"https://old.example"}]}';
    writeFileSync(join(directory, 'floway.json'), connections);
    const script = [
      'main() { :; }; out_error() { printf "%s\\n" "$*" >&2; }; out_warn() { :; };',
      readFileSync(join(packageRoot, 'installers/bash/common/managed-file.sh'), 'utf8'),
      `source ${quote(join(packageRoot, 'installers/bash/pi.sh'))};`,
      `PI_CONNECTIONS_PATH=${quote(join(directory, 'floway.json'))}; PI_AUTH_PATH=${quote(join(directory, 'auth.json'))}; PI_EXTENSION_PATH=${quote(join(directory, 'floway.js'))}; PI_SETTINGS_PATH=${quote(join(directory, 'settings.json'))}; SETUP_TMPDIR=${quote(directory)}; SETUP_PI_PROVIDER=floway; SETUP_API_KEY=new-key;`,
      `_write_jsonc_editor() { cp ${quote(join(packageRoot, 'installers/node/jsonc-edit.mjs'))} "$SETUP_TMPDIR/jsonc-edit.mjs"; };`,
      'JQ=jq; ensure_jq() { :; }; SETUP_ENDPOINT=https://new.example; pi_backup_files && pi_stage_auth || exit $?;',
      'PI_CONNECTIONS_STAGE="$PI_CONNECTIONS_PATH.floway-stage.$$"; _stage_provider_connections "$PI_CONNECTIONS_PATH" "$PI_CONNECTIONS_STAGE" floway || exit $?;',
      'PI_EXTENSION_STAGE="$PI_EXTENSION_PATH.floway-stage.$$"; printf "new extension" > "$PI_EXTENSION_STAGE";',
      'mv() { if [ "$1" = "$PI_EXTENSION_STAGE" ]; then node -e \'if(JSON.parse(require("fs").readFileSync(process.argv[1])).floway.key!=="new-key")process.exit(1)\' "$PI_AUTH_PATH" || exit $?; printf "auth replacement observed\\n"; return 73; fi; command mv "$@"; };',
      'pi_apply_staged; status=$?; [ "$status" -ne 0 ] || exit 90; pi_rollback;',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('auth replacement observed');
    expect(readFileSync(join(directory, 'auth.json'), 'utf8')).toBe(auth);
    expect(readFileSync(join(directory, 'floway.json'), 'utf8')).toBe(connections);
    expect(readFileSync(join(directory, 'floway.js'), 'utf8')).toBe('original extension');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
