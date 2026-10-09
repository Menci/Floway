import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const hasPowerShell = spawnSync('pwsh', ['--version']).status === 0;
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

describe.skipIf(!hasPowerShell)('PowerShell captured and live process launch boundary', () => {
  for (const extension of ['', '.cmd']) {
    for (const mode of ['captured', 'live'] as const) {
      test(`${mode} preserves argv through ${extension || 'native executable'} invocation`, () => {
        const directory = mkdtempSync(join(packageRoot, '.process-launch-test-'));
        try {
          const output = join(directory, 'argv.json');
          const executable = join(directory, `launcher with ' space${extension}`);
          writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "$@"\n`);
          chmodSync(executable, 0o700);
          const args = ['space value', 'quote"value', "single'value", 'trailing\\', '\\"', 'line\nnext', '中文'];
          const helper = readFileSync(join(packageRoot, 'installers/powershell/common/process.ps1'), 'utf8');
          const script = [
            "$ErrorActionPreference='Stop'; function Test-SetupIsWindows { $true }; function Stop-Setup { param([string]$Message) throw $Message };",
            helper,
            `${mode === 'live' ? 'Invoke-SetupLiveProcess' : '$result = Invoke-SetupProcess'} -Exe ${quote(executable)} -Arguments @(${[output, ...args].map(quote).join(', ')}) -TimeoutSeconds 10;`,
            mode === 'captured' ? 'if ($result.ExitCode -ne 0) { throw $result.Output }' : '',
          ].join('\n');
          const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 15000 });
          expect(result.status, result.stdout + result.stderr).toBe(0);
          expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(args);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }

  test('a captured probe receives EOF while its PowerShell caller input stays open', async () => {
    const helper = readFileSync(join(packageRoot, 'installers/powershell/common/process.ps1'), 'utf8');
    const nodeProbe = 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("probe-eof"));';
    const script = [
      "$ErrorActionPreference='Stop'; function Test-SetupIsWindows { $false }; function Stop-Setup { param([string]$Message) throw $Message };",
      helper,
      `$result = Invoke-SetupProcess -Exe ${quote(process.execPath)} -Arguments @('-e', ${quote(nodeProbe)}) -TimeoutSeconds 2;`,
      'if ($result.ExitCode -ne 0) { throw $result.Output }; [Console]::Write($result.Output);',
    ].join('\n');
    const child = spawn('pwsh', ['-NoProfile', '-Command', script]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    child.stdin.destroy();
    expect(status, stderr).toBe(0);
    expect(stdout).toBe('probe-eof');
  });
});
