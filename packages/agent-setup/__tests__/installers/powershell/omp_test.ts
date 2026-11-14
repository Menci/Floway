import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { SETUP_SCRIPT_BODIES } from '../../../src/script-assets.ts';

const hasPowerShell = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;

test.skipIf(!hasPowerShell)('PowerShell OMP restores plugin credentials when rollback cannot inspect the existing link', () => {
  const directory = mkdtempSync(join(process.cwd(), '.omp-link-rollback-test-'));
  try {
    const original = '{"settings":{"@floway-dev/omp":{"connections":[{"apiKey":"original-key"}]}}}';
    const lockPath = join(directory, 'omp-plugins.lock.json');
    const backupPath = join(directory, 'omp-plugins.lock.json.backup');
    writeFileSync(lockPath, '{"settings":{"@floway-dev/omp":{"connections":[{"apiKey":"new-key"}]}}}');
    writeFileSync(backupPath, original, { mode: 0o600 });
    const body = SETUP_SCRIPT_BODIES.omp.ps1;
    const fragment = body.slice(0, body.lastIndexOf("$global:LASTEXITCODE = Main 'oh-my-pi'"));
    const scriptPath = join(directory, 'rollback.ps1');
    writeFileSync(scriptPath, `$ErrorActionPreference = 'Stop'\n${fragment}\n
$script:OmpPluginSettingsStage = $null
$script:OmpExtensionStage = $null
$script:OmpManifestStage = $null
$script:OmpConfigStage = $null
$script:OmpPluginLinkExisted = $true
$script:OmpPluginLinkAttempted = $true
$script:OmpExtensionExisted = $false
$script:OmpManifestExisted = $false
$script:OmpConfigExisted = $false
$script:OmpPluginLinkPath = Join-Path $args[0] 'link'
$script:OmpPluginDir = Join-Path $args[0] 'package'
$script:OmpExtensionPath = Join-Path $args[0] 'index.js'
$script:OmpManifestPath = Join-Path $args[0] 'package.json'
$script:OmpConfigPath = Join-Path $args[0] 'config.yml'
$script:OmpPluginSettingsExisted = $true
$script:OmpPluginSettingsBackup = Join-Path $args[0] 'omp-plugins.lock.json.backup'
$script:OmpPluginSettingsPath = Join-Path $args[0] 'omp-plugins.lock.json'
function Get-Item {
  param([string]$LiteralPath, [switch]$Force, [string]$ErrorAction)
  throw [System.UnauthorizedAccessException]::new('injected link query failure')
}
Restore-SetupOmpFiles
`);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptPath, directory], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('could not restore the existing @floway-dev/omp plugin link');
    expect(readFileSync(lockPath, 'utf8')).toBe(original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
