import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { defaultAgentSetupConfiguration } from '../../../src/configuration.ts';
import { renderPowerShellPrefix } from '../../../src/render.ts';
import { SETUP_SCRIPT_BODIES } from '../../../src/script-assets.ts';

const hasPowerShell = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;

test.skipIf(!hasPowerShell)('PowerShell Pi protects a reused settings stage before writing editor output', () => {
  const directory = mkdtempSync(join(process.cwd(), '.pi-stage-protection-test-'));
  try {
    const original = '{ "untouched": "private-setting" }';
    writeFileSync(join(directory, 'settings.json'), original);
    const body = SETUP_SCRIPT_BODIES.pi.ps1;
    const fragment = body.slice(0, body.lastIndexOf("$global:LASTEXITCODE = Main 'Pi'"));
    const prefix = renderPowerShellPrefix({ agent: 'pi', extensionPath: '/pi.js', apiKey: 'key', apiKeyName: 'Test', configuration: defaultAgentSetupConfiguration('key-a') });
    const scriptPath = join(directory, 'stage-protection.ps1');
    writeFileSync(scriptPath, `${prefix}\n$ErrorActionPreference = 'Stop'\n${fragment}\n
$script:PiTmpDir = $args[0]
$script:PiSettingsPath = Join-Path $args[0] 'settings.json'
$stage = "$($script:PiSettingsPath).floway-stage.$([System.Diagnostics.Process]::GetCurrentProcess().Id)"
[System.IO.File]::WriteAllText($stage, '')
& chmod 644 $stage
function Protect-SetupFile {
  param([string]$Path)
  if ([System.IO.File]::ReadAllText($Path).Contains('private-setting')) { throw 'Settings were written before stage protection' }
  & chmod 600 $Path
  if ($LASTEXITCODE -ne 0) { throw 'Stage protection failed' }
}
Stage-SetupPiSettings
if ([System.IO.File]::ReadAllText($script:PiSettingsStage) -cne [System.IO.File]::ReadAllText($script:PiSettingsPath)) { throw 'Settings changed' }
`);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptPath, directory], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe(original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(!hasPowerShell)('PowerShell Pi preserves large settings through the JSONC subprocess pipe', () => {
  const directory = mkdtempSync(join(process.cwd(), '.pi-large-settings-test-'));
  try {
    const original = JSON.stringify({ untouched: 'x'.repeat(2 * 1024 * 1024), sentinel: 'complete' });
    writeFileSync(join(directory, 'settings.json'), original);
    const body = SETUP_SCRIPT_BODIES.pi.ps1;
    const fragment = body.slice(0, body.lastIndexOf("$global:LASTEXITCODE = Main 'Pi'"));
    const prefix = renderPowerShellPrefix({ agent: 'pi', extensionPath: '/pi.js', apiKey: 'key', apiKeyName: 'Test', configuration: defaultAgentSetupConfiguration('key-a') });
    const scriptPath = join(directory, 'large-settings.ps1');
    writeFileSync(scriptPath, `${prefix}\n$ErrorActionPreference = 'Stop'\n${fragment}\n
$script:PiTmpDir = $args[0]
$script:PiSettingsPath = Join-Path $args[0] 'settings.json'
Stage-SetupPiSettings
[System.IO.File]::Copy($script:PiSettingsStage, (Join-Path $args[0] 'settings.json.stage'))
`);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptPath, directory], { encoding: 'utf8', timeout: 20000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const staged = readFileSync(join(directory, 'settings.json.stage'), 'utf8');
    expect(staged.length).toBe(original.length);
    expect(staged).toBe(original);
    expect(JSON.parse(staged).sentinel).toBe('complete');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(!hasPowerShell)('PowerShell native boolean prefixes write Pi retry values and preserve null preferences', () => {
  const directory = mkdtempSync(join(process.cwd(), '.pi-settings-test-'));
  try {
    const body = SETUP_SCRIPT_BODIES.pi.ps1;
    const fragment = body.slice(0, body.lastIndexOf("$global:LASTEXITCODE = Main 'Pi'"));
    for (const enabled of [false, true, null]) {
      const configuration = defaultAgentSetupConfiguration('key-a');
      configuration.pi.retry = { enabled, maxRetries: enabled === null ? null : 0 };
      const original = { retry: { enabled: true, maxRetries: 7, baseDelayMs: 3500 } };
      const settingsPath = join(directory, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify(original));
      const prefix = renderPowerShellPrefix({ agent: 'pi', extensionPath: '/pi.js', apiKey: 'key', apiKeyName: 'Test', configuration });
      const script = `${prefix}\n$ErrorActionPreference = 'Stop'\n${fragment}\n
if ($null -ne $SetupPiRetryEnabled -and $SetupPiRetryEnabled -isnot [bool]) { throw 'Expected a native PowerShell boolean prefix' }
$script:PiTmpDir = $args[0]
$script:PiSettingsPath = Join-Path $args[0] 'settings.json'
Stage-SetupPiSettings
[System.IO.File]::Copy($script:PiSettingsStage, $script:PiSettingsPath, $true)
`;
      const scriptPath = join(directory, 'preferences.ps1');
      writeFileSync(scriptPath, script);
      const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptPath, directory], { encoding: 'utf8' });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(enabled === null ? original : { retry: { enabled, maxRetries: 0, baseDelayMs: 3500 } });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(!hasPowerShell).each([
  { output: 'upstream probe failure', code: 73, expected: '`node -v` failed. upstream probe failure' },
  { output: '', code: 0, expected: 'Node.js returned an invalid version.' },
  { output: 'invalid.version', code: 0, expected: 'Node.js returned an invalid version.' },
])('PowerShell rejects failed or invalid required Node probes: $output', ({ output, code, expected }) => {
  const directory = mkdtempSync(join(process.cwd(), '.pi-node-probe-test-'));
  try {
    const executable = join(directory, 'node');
    writeFileSync(executable, `#!/bin/sh\nprintf '%s' '${output}'\nexit ${code}\n`);
    chmodSync(executable, 0o700);
    const body = SETUP_SCRIPT_BODIES.pi.ps1;
    const fragment = body.slice(0, body.lastIndexOf("$global:LASTEXITCODE = Main 'Pi'"));
    const script = `$ErrorActionPreference='Stop'; $PSNativeCommandUseErrorActionPreference=$false;\n${fragment}\nTest-SetupPiNode`;
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(!hasPowerShell)('PowerShell Pi prunes obsolete settings backups after extension-only setup', () => {
  const directory = mkdtempSync(join(process.cwd(), '.pi-backup-cleanup-test-'));
  try {
    mkdirSync(join(directory, 'extensions'));
    writeFileSync(join(directory, 'extensions', 'floway.js'), '// Managed by Floway Agent Setup.\n');
    const backup = join(directory, 'settings.json.floway-backup.old');
    writeFileSync(backup, '{}');
    const body = SETUP_SCRIPT_BODIES.pi.ps1;
    const fragment = body.slice(0, body.lastIndexOf("$global:LASTEXITCODE = Main 'Pi'"));
    const script = `$ErrorActionPreference='Stop';\n${fragment}\n
$script:PiExtensionPath=Join-Path $args[0] 'extensions/floway.js'
$script:PiSettingsPath=Join-Path $args[0] 'settings.json'
$script:PiAuthPath=Join-Path $args[0] 'auth.json'
$script:PiConnectionsPath=Join-Path $args[0] 'floway.json'
$script:PiExtensionBackup=$null
$script:PiSettingsBackup=$null
$script:PiAuthBackup=$null
Remove-SetupPiBackups
`;
    const scriptPath = join(directory, 'cleanup.ps1');
    writeFileSync(scriptPath, script);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptPath, directory], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(join(directory, 'settings.json'))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(!hasPowerShell)('PowerShell Pi restores credentials after a later extension replacement fails', () => {
  const directory = mkdtempSync(join(process.cwd(), '.pi-auth-rollback-test-'));
  try {
    const auth = '{"openai":{"type":"api_key","key":"other-key"},"floway":{"type":"api_key","key":"old-key"}}';
    writeFileSync(join(directory, 'auth.json'), auth);
    writeFileSync(join(directory, 'floway.js'), 'original extension');
    writeFileSync(join(directory, 'settings.json'), '{}');
    const connections = '{"connections":[{"provider":"floway","endpoint":"https://old.example"}]}';
    writeFileSync(join(directory, 'floway.json'), connections);
    const body = SETUP_SCRIPT_BODIES.pi.ps1;
    const fragment = body.slice(0, body.lastIndexOf("$global:LASTEXITCODE = Main 'Pi'"));
    const prefix = renderPowerShellPrefix({ agent: 'pi', extensionPath: '/pi.js', apiKey: 'new-key', apiKeyName: 'Test', configuration: defaultAgentSetupConfiguration('key-a') });
    const script = `${prefix}\n$ErrorActionPreference='Stop'\n${fragment}\n
$SetupEndpoint='https://new.example'
$script:PiTmpDir=$args[0]
$script:PiAuthPath=Join-Path $args[0] 'auth.json'
$script:PiConnectionsPath=Join-Path $args[0] 'floway.json'
$script:PiExtensionPath=Join-Path $args[0] 'floway.js'
$script:PiSettingsPath=Join-Path $args[0] 'settings.json'
Backup-SetupPiFiles
Stage-SetupPiAuth
$script:PiConnectionsStage="$($script:PiConnectionsPath).floway-stage"
Stage-SetupProviderConnections -ExistingPath $script:PiConnectionsPath -StagePath $script:PiConnectionsStage -Provider $SetupPiProvider -IncludeKey $false
$script:PiExtensionStage="$($script:PiExtensionPath).floway-stage"
[IO.File]::WriteAllText($script:PiExtensionStage,'new extension')
function Move-Item {
  param([string]$LiteralPath,[string]$Destination,[switch]$Force)
  if ($LiteralPath -eq $script:PiExtensionStage) {
    $value=[IO.File]::ReadAllText($script:PiAuthPath)|ConvertFrom-Json
    if ($value.floway.key -ne 'new-key') { throw 'Auth replacement was not reached' }
    $connection=[IO.File]::ReadAllText($script:PiConnectionsPath)|ConvertFrom-Json
    if ($connection.connections[0].endpoint -ne $SetupEndpoint.TrimEnd('/')) { throw 'Connection replacement was not reached' }
    Write-Output 'auth replacement observed'
    throw 'test replacement failure'
  }
  Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
}
try { Apply-SetupPiStaged; throw 'Failure was not reached' } catch { if ($_.Exception.Message -ne 'test replacement failure') { throw }; Restore-SetupPiFiles }
`;
    const path = join(directory, 'rollback.ps1');
    writeFileSync(path, script);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', path, directory], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('auth replacement observed');
    expect(readFileSync(join(directory, 'auth.json'), 'utf8')).toBe(auth);
    expect(readFileSync(join(directory, 'floway.json'), 'utf8')).toBe(connections);
    expect(readFileSync(join(directory, 'floway.js'), 'utf8')).toBe('original extension');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(!hasPowerShell).each([false, true])('PowerShell Pi protects the native auth backup before writing credentials (protection failure: %s)', failProtection => {
  const directory = mkdtempSync(join(process.cwd(), '.pi-auth-backup-test-'));
  try {
    const original = '\uFEFF{"floway":{"type":"api_key","key":"synthetic-native-key"},"other":{"type":"api_key","key":"synthetic-other-key"}}\r\n';
    const authPath = join(directory, 'auth.json');
    writeFileSync(authPath, original, { mode: 0o600 });
    const body = SETUP_SCRIPT_BODIES.pi.ps1;
    const fragment = body.slice(0, body.lastIndexOf("$global:LASTEXITCODE = Main 'Pi'"));
    const scriptPath = join(directory, 'backup.ps1');
    writeFileSync(scriptPath, `$ErrorActionPreference='Stop'\n${fragment}\n
$script:PiExtensionPath=Join-Path $args[0] 'floway.js'
$script:PiConnectionsPath=Join-Path $args[0] 'floway.json'
$script:PiSettingsPath=Join-Path $args[0] 'settings.json'
$script:PiAuthPath=Join-Path $args[0] 'auth.json'
$script:FailProtection=$${failProtection}
$script:ProtectionObserved=$false
$script:NativeProtection=(Get-Command Protect-SetupFile).ScriptBlock
function Protect-SetupFile {
  param([string]$Path)
  if ($Path -ne $script:PiAuthBackup) { throw 'Unexpected protection target' }
  if ([IO.File]::ReadAllBytes($Path).Length -ne 0) { throw 'Credentials were written before backup protection' }
  $script:ProtectionObserved=$true
  if ($script:FailProtection) { throw 'injected protection failure' }
  & $script:NativeProtection $Path
}
try {
  Backup-SetupPiFiles
  if ($script:FailProtection) { throw 'Protection failure was not reached' }
} catch {
  if (-not $script:FailProtection -or $_.Exception.Message -ne 'injected protection failure') { throw }
}
if (-not $script:ProtectionObserved) { throw 'Protection was not reached' }
[PSCustomObject]@{ BackupFile=[IO.Path]::GetFileName($script:PiAuthBackup) } | ConvertTo-Json -Compress
`);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptPath, directory], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const { BackupFile } = JSON.parse(result.stdout) as { BackupFile: string };
    const backup = join(directory, BackupFile);
    expect(readFileSync(authPath, 'utf8')).toBe(original);
    expect(readFileSync(backup, 'utf8')).toBe(failProtection ? '' : original);
    if (!failProtection && process.platform !== 'win32') expect(statSync(backup).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(!hasPowerShell).each(['auth', 'settings'] as const)('PowerShell Pi preserves native UTF-8 bytes through the %s editor process', mode => {
  const directory = mkdtempSync(join(process.cwd(), '.pi-bom-transport-test-'));
  try {
    const original = mode === 'auth'
      ? '\uFEFF{\r\n  "floway": {"type":"api_key","key":"old-key"},\r\n  "other": {"type":"api_key","key":"keep-key","env":{"KEEP":"保留"}}\r\n}\r\n'
      : '\uFEFF{\r\n  // 保留设置\r\n  "defaultProvider": "other",\r\n  "defaultModel": "other-model",\r\n  "defaultThinkingLevel": "low"\r\n}\r\n';
    const input = join(directory, `${mode}.json`);
    writeFileSync(input, original);
    const configuration = defaultAgentSetupConfiguration('key-a');
    configuration.pi.thinkingLevel = 'high';
    const prefix = renderPowerShellPrefix({ agent: 'pi', extensionPath: '/pi.js', apiKey: 'rotated-key', apiKeyName: 'Test', configuration });
    const body = SETUP_SCRIPT_BODIES.pi.ps1;
    const fragment = body.slice(0, body.lastIndexOf("$global:LASTEXITCODE = Main 'Pi'"));
    const scriptPath = join(directory, 'transport.ps1');
    writeFileSync(scriptPath, `${prefix}\n$ErrorActionPreference='Stop'\n${fragment}\n
$script:PiTmpDir=$args[0]
$script:Pi${mode === 'auth' ? 'Auth' : 'Settings'}Path=Join-Path $args[0] '${mode}.json'
Stage-SetupPi${mode === 'auth' ? 'Auth' : 'Settings'}
[IO.File]::Copy($script:Pi${mode === 'auth' ? 'Auth' : 'Settings'}Stage, (Join-Path $args[0] 'staged.json'))
`);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptPath, directory], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(input, 'utf8')).toBe(original);
    expect(readFileSync(join(directory, 'staged.json'), 'utf8')).toBe(mode === 'auth' ? original.replace('old-key', 'rotated-key') : original.replace('"low"', '"high"'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
