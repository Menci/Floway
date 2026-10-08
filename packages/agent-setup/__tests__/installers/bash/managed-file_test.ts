import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

test('Bash extension serialization propagates a failed header read without replacing its stage', () => {
  const directory = mkdtempSync(join(packageRoot, '.extension-merge-test-'));
  try {
    const stage = join(directory, 'stage.js');
    const original = '// Managed by Floway Agent Setup.\nconst connections = [{"provider":"work","endpoint":"https://gateway.example","apiKey":"key"}];\nexport default () => {};\n';
    writeFileSync(stage, original);
    const helper = readFileSync(join(packageRoot, 'installers/bash/common/managed-file.sh'), 'utf8');
    const script = [
      'set +e; out_error() { printf "%s\\n" "$*" >&2; }; ensure_jq() { :; }; JQ=test_jq;',
      `SETUP_TMPDIR=${quote(directory)};`,
      'test_jq() { command jq "$@"; local status=$?; rm "$SETUP_TMPDIR/provider-connections.json"; return "$status"; };',
      helper,
      `_merge_provider_extension ${quote(join(directory, 'missing.js'))} ${quote(stage)}; exit $?;`,
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(readFileSync(stage, 'utf8')).toBe(original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
