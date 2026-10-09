import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { SETUP_SCRIPT_BODIES } from '../../../src/script-assets.ts';

const hasPowerShell = spawnSync('pwsh', ['--version']).status === 0;

test.skipIf(!hasPowerShell).each([
  { agent: 'pi', windowsReplacement: false },
  { agent: 'pi', windowsReplacement: true },
  { agent: 'omp', windowsReplacement: false },
  { agent: 'omp', windowsReplacement: true },
] as const)('PowerShell $agent keeps protected replacements without a second permission operation ($windowsReplacement)', ({ agent, windowsReplacement }) => {
  const directory = mkdtempSync(join(process.cwd(), '.managed-stage-test-'));
  try {
    const files = agent === 'pi' ? ['extension', 'settings', 'auth', 'connections'] : ['extension', 'settings', 'connections'];
    for (const name of files) {
      writeFileSync(join(directory, name), 'original');
      writeFileSync(join(directory, `${name}.stage`), 'replacement');
      chmodSync(join(directory, `${name}.stage`), 0o600);
    }
    const host = agent === 'pi' ? 'Pi' : 'Omp';
    const settings = agent === 'pi' ? 'Settings' : 'Config';
    const body = SETUP_SCRIPT_BODIES[agent].ps1;
    const fragment = body.slice(0, body.lastIndexOf('$global:LASTEXITCODE = Main '));
    const scriptPath = join(directory, 'apply.ps1');
    writeFileSync(scriptPath, `$ErrorActionPreference = 'Stop'\n${fragment}\n
function Test-SetupIsWindows { $${windowsReplacement} }
$script:ProtectionCalls = 0
function Protect-SetupFile {
  param([string]$Path)
  if ([System.IO.File]::ReadAllText($Path) -cne 'original') { throw 'Protection repeated after replacement' }
  $script:ProtectionCalls++
}
$script:${host}ConnectionsPath = Join-Path $args[0] 'connections'
$script:${host}ConnectionsStage = Join-Path $args[0] 'connections.stage'
$script:${host}ConnectionsExisted = $true
$script:${host}ExtensionPath = Join-Path $args[0] 'extension'
$script:${host}ExtensionStage = Join-Path $args[0] 'extension.stage'
$script:${host}ExtensionExisted = $true
$script:${host}${settings}Path = Join-Path $args[0] 'settings'
$script:${host}${settings}Stage = Join-Path $args[0] 'settings.stage'
$script:${host}${settings}Existed = $true
${agent === 'pi' ? `$script:PiAuthPath = Join-Path $args[0] 'auth'\n$script:PiAuthStage = Join-Path $args[0] 'auth.stage'\n$script:PiAuthExisted = $true` : ''}
Apply-Setup${host}Staged
if ($script:ProtectionCalls -ne ${windowsReplacement ? files.length : 0}) { throw 'Unexpected protection boundary' }
if ($null -ne $script:${host}ExtensionStage -or $null -ne $script:${host}${settings}Stage) { throw 'Stage remains pending' }
`);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptPath, directory], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    for (const name of files) {
      expect(readFileSync(join(directory, name), 'utf8')).toBe('replacement');
      expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
