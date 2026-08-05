import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { SETUP_POWERSHELL_COMMON_JSON_DOCUMENT } from '../../../src/script-assets.generated.ts';

const hostPwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
  encoding: 'utf8',
}).status === 0 ? 'pwsh' : null;

test.skipIf(hostPwsh === null)('PowerShell JSON helpers reject malformed syntax without collapsing exact-case keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'floway-powershell-json.'));
  const resultPath = join(root, 'result.txt');
  const scriptPath = join(root, 'probe.ps1');
  try {
    writeFileSync(scriptPath, `${SETUP_POWERSHELL_COMMON_JSON_DOCUMENT}
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
[System.IO.File]::WriteAllText($env:FLOWAY_PS_JSON_RESULT, ($results -join ','))
`);
    const result = spawnSync(hostPwsh!, ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, FLOWAY_PS_JSON_RESULT: resultPath },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(resultPath, 'utf8')).toBe('rejected,rejected,rejected,accepted,accepted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
