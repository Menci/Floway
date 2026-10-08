import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { defaultAgentSetupConfiguration } from '../../../src/configuration.ts';
import { renderPowerShellPrefix } from '../../../src/render.ts';

const hasPowerShell = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;

test.skipIf(!hasPowerShell)('PowerShell native boolean prefixes write Pi retry values and preserve null preferences', () => {
  const directory = mkdtempSync(join(process.cwd(), '.pi-settings-test-'));
  try {
    writeFileSync(join(directory, 'jsonc-edit.mjs'), readFileSync(new URL('../../../installers/node/jsonc-edit.mjs', import.meta.url)));
    const fragment = readFileSync(new URL('../../../installers/powershell/pi.ps1', import.meta.url), 'utf8').replace(/^\$global:LASTEXITCODE = Main 'Pi'$/m, '');
    const common = ['platform', 'managed-file'].map(name => readFileSync(new URL(`../../../installers/powershell/common/${name}.ps1`, import.meta.url), 'utf8')).join('\n');
    for (const enabled of [false, true, null]) {
      const configuration = defaultAgentSetupConfiguration('key-a');
      configuration.pi.retry = { enabled, maxRetries: enabled === null ? null : 0 };
      const original = { retry: { enabled: true, maxRetries: 7, baseDelayMs: 3500 } };
      const settingsPath = join(directory, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify(original));
      const prefix = renderPowerShellPrefix({ agent: 'pi', extensionPath: '/pi.js', apiKey: 'key', apiKeyName: 'Test', configuration });
      const script = `${prefix}\n$ErrorActionPreference = 'Stop'\n${common}\n${fragment}\n
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
