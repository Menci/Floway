import { spawnSync } from 'node:child_process';

import { expect, test } from 'vitest';

import { SETUP_POWERSHELL_COMMON_JSON_DOCUMENT } from '../../../src/script-assets.generated.ts';

const hostPwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
  encoding: 'utf8',
}).status === 0 ? 'pwsh' : null;

test.skipIf(hostPwsh === null)('PowerShell JSON helpers reject malformed syntax without collapsing exact-case keys', () => {
  const result = spawnSync(hostPwsh!, ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    encoding: 'utf8',
    input: `${SETUP_POWERSHELL_COMMON_JSON_DOCUMENT}
$cases = @(
  '{"x":1,}',
  '{"x":01}',
  '{"x":1,"x":2}',
  '{"x":1,"X":2}',
  '{"__type":1}'
)
$results = foreach ($json in $cases) {
  try { $null = Read-SetupJsonDocument $json; 'accepted' } catch { 'rejected' }
}
[Console]::Out.Write(($results -join ','))
`,
  });

  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout, result.stderr).toBe('rejected,rejected,rejected,accepted,accepted');
});
