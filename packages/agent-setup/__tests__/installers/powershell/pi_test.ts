import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { defaultAgentSetupConfiguration } from '../../../src/configuration.ts';
import { renderPowerShellPrefix } from '../../../src/render.ts';
import { SETUP_SCRIPT_BODIES } from '../../../src/script-assets.ts';

const hasPowerShell = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;

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
