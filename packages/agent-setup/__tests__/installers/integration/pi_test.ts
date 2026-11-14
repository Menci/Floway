import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

import { expect, test } from 'vitest';

import { ALL_BASH_FRAGMENTS, HARNESS_ROOT, SENTINEL_KEY, SHIM_BIN, hostPiBin, hostPwsh, installerMarker, makeWorkspace, modelServer, piBackupFiles, piConfig, piDirFor, piExtensionPath, piFixture, piSettingsPath, piStagedFiles, placeFakeNpm, placeFakePi, powerShellBody, powerShellEntry, readPiSettings, runPowerShellInstaller, runShellInstaller, runShellInstallerWithAmbientKey, shellBody, shellEntry, shellLiteral } from './harness';
import type { RunResult } from './harness';
import { renderPowerShellPrefix, renderShellPrefix } from '../../../src/render.ts';
import { SETUP_BASH_PI, SETUP_NODE_PI_EXTENSION, SETUP_POWERSHELL_PI } from '../../../src/script-assets.generated.ts';

for (const [label, runInstaller] of [['Bash', runShellInstaller], ['PowerShell', runPowerShellInstaller]] as const) {
  test(`${label}: installs a protected fixed extension and preserves unrelated configuration`, { timeout: 180_000 }, async ({ skip }) => {
    if (label === 'PowerShell' && !hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    mkdirSync(piDirFor(ws), { recursive: true });
    const unrelated = '// Unrelated provider\r\n{"providers":{"openai":{"apiKey":"original"}}}\r\n';
    const modelsPath = join(piDirFor(ws), 'models.json');
    writeFileSync(modelsPath, unrelated);
    const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
    expect(run.code, run.combined).toBe(0);
    const extension = piExtensionPath(ws);
    expect(existsSync(extension)).toBeTruthy();
    expect(statSync(extension).mode & 0o777, 'extension is private').toBe(0o600);
    const source = readFileSync(extension, 'utf8');
    expect(source, 'the shared extension contains no key').not.toContain(SENTINEL_KEY);
    const auth = JSON.parse(readFileSync(join(piDirFor(ws), 'auth.json'), 'utf8'));
    expect(auth.floway.type).toBe('api_key');
    expect(auth.floway.key).toBe(SENTINEL_KEY);
    expect(statSync(join(piDirFor(ws), 'auth.json')).mode & 0o777, 'credentials are private').toBe(0o600);
    expect(source, 'extension is the fixed resource').toBe(SETUP_NODE_PI_EXTENSION);
    expect(JSON.parse(readFileSync(join(piDirFor(ws), 'floway.json'), 'utf8')).connections[0].endpoint).toBe(modelServer.url);
    expect(readFileSync(modelsPath, 'utf8'), 'unrelated models.json preserved byte for byte').toBe(unrelated);
    expect(!existsSync(piSettingsPath(ws))).toBeTruthy();
    expect(modelServer.requests.some(request => request.path.endsWith('/pi.js'))).toBeTruthy();
    expect(!modelServer.requests.some(request => request.path.endsWith('/v1/models'))).toBeTruthy();
    expect(run.combined, 'key never logged').not.toContain(SENTINEL_KEY);
    const second = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
    expect(second.code, second.combined).toBe(0);
    expect(readFileSync(extension, 'utf8'), 'repeat setup is idempotent').toBe(source);
    expect(piBackupFiles(join(piDirFor(ws), 'extensions'), 'floway.js').length, 'backups pruned').toBe(0);
  });

  test(`${label}: rollback restores extension and settings after the injected configuration failure`, { timeout: 180_000 }, async ({ skip }) => {
    if (label === 'PowerShell' && !hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    mkdirSync(join(piDirFor(ws), 'extensions'), { recursive: true });
    const extension = piExtensionPath(ws);
    const settings = piSettingsPath(ws);
    const original = SETUP_NODE_PI_EXTENSION;
    writeFileSync(extension, original);
    writeFileSync(settings, '{"theme":"dark"}');
    const connectionPath = join(piDirFor(ws), 'floway.json');
    const connections = '{"connections":[{"provider":"old","endpoint":"https://old.example"}]}';
    writeFileSync(connectionPath, connections);
    const auth = join(piDirFor(ws), 'auth.json');
    const credentials = '{"openai":{"type":"api_key","key":"original"}}';
    writeFileSync(auth, credentials);
    const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'm' }), fakePiFailConfig: true });
    expect(run.code, 'injected failure aborts').not.toBe(0);
    expect(run.combined, 'fault reached after successful extension staging').toContain('Pi simulated failure; rolling back configuration.');
    expect(readFileSync(extension, 'utf8')).toBe(original);
    expect(readFileSync(settings, 'utf8')).toBe('{"theme":"dark"}');
    expect(readFileSync(auth, 'utf8')).toBe(credentials);
    expect(readFileSync(connectionPath, 'utf8')).toBe(connections);
    expect(piStagedFiles(join(piDirFor(ws), 'extensions')).length).toBe(0);
  });

  test(`${label}: malformed native credentials fail without changing files or exposing values`, { timeout: 180_000 }, async ({ skip }) => {
    if (label === 'PowerShell' && !hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    mkdirSync(piDirFor(ws), { recursive: true });
    const path = join(piDirFor(ws), 'auth.json');
    const original = '{"openai":{"type":"api_key","key":"existing-private-key"}} trailing';
    writeFileSync(path, original);
    const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
    expect(run.code).not.toBe(0);
    expect(run.combined).toContain('Invalid JSON in auth.json');
    expect(run.combined).not.toContain('existing-private-key');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(!existsSync(piExtensionPath(ws))).toBeTruthy();
  });

  test(`${label}: settings JSONC comments and line endings survive default changes`, { timeout: 180_000 }, async ({ skip }) => {
    if (label === 'PowerShell' && !hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    mkdirSync(piDirFor(ws), { recursive: true });
    writeFileSync(piSettingsPath(ws), '// Settings\r\n{\r\n  "theme": "dark",\r\n}');
    const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'm' }) });
    expect(run.code, run.combined).toBe(0);
    const settings = readFileSync(piSettingsPath(ws), 'utf8');
    expect(settings).toContain('// Settings\r\n');
    expect(settings).toContain('"theme": "dark",');
    expect(settings).toContain('"defaultModel": "m"');
  });

  test(`${label}: refuses to replace a manually authored extension`, { timeout: 180_000 }, async ({ skip }) => {
    if (label === 'PowerShell' && !hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    mkdirSync(join(piDirFor(ws), 'extensions'), { recursive: true });
    const extension = piExtensionPath(ws);
    writeFileSync(extension, 'export default () => {};');
    const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'm' }) });
    expect(run.code).not.toBe(0);
    expect(run.combined).toContain('an unmanaged floway.js extension already exists');
    expect(readFileSync(extension, 'utf8')).toBe('export default () => {};');
    expect(!existsSync(piSettingsPath(ws))).toBeTruthy();
  });

  test(`${label}: rejects empty and HTML extension downloads before replacing files`, { timeout: 180_000 }, async ({ skip }) => {
    if (label === 'PowerShell' && !hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
    for (const path of ['/empty-extension.js', '/invalid-extension.js']) {
      const ws = makeWorkspace();
      placeFakePi(ws.binDir);
      mkdirSync(join(piDirFor(ws), 'extensions'), { recursive: true });
      const extension = piExtensionPath(ws);
      const source = '// Managed by Floway Agent Setup.\noriginal extension';
      writeFileSync(extension, source);
      const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'm' }), piExtensionUrl: modelServer.url + path });
      expect(run.code).not.toBe(0);
      expect(readFileSync(extension, 'utf8')).toBe(source);
      expect(!existsSync(piSettingsPath(ws))).toBeTruthy();
      expect(piStagedFiles(join(piDirFor(ws), 'extensions')).length).toBe(0);
      expect(run.combined).not.toContain(SENTINEL_KEY);
    }
  });

  test(`${label}: respects PI_CODING_AGENT_DIR`, { timeout: 180_000 }, async ({ skip }) => {
    if (label === 'PowerShell' && !hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    const agentDir = join(ws.root, 'custom agent');
    const run = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), piAgentDir: agentDir });
    expect(run.code, run.combined).toBe(0);
    expect(existsSync(join(agentDir, 'extensions/floway.js'))).toBeTruthy();
  });
}

test('model set, changed, and cleared updates settings.json', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const settingsFile = piSettingsPath(ws);

  const run1 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  expect(run1.code, `setting model should succeed:\n${run1.combined}`).toBe(0);
  expect(existsSync(settingsFile)).toBeTruthy();
  expect(statSync(settingsFile).mode & 0o777, 'settings.json permissions are 0600').toBe(0o600);
  let settings = readPiSettings(settingsFile);
  expect(settings.defaultProvider).toBe('floway');
  expect(settings.defaultModel).toBe('floway-pi-model-1');

  const run2 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'model-2' }) });
  expect(run2.code, `changing model should succeed:\n${run2.combined}`).toBe(0);
  settings = readPiSettings(settingsFile);
  expect(settings.defaultProvider).toBe('floway');
  expect(settings.defaultModel).toBe('model-2');

  const run3 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: null }) });
  expect(run3.code, `clearing model should succeed:\n${run3.combined}`).toBe(0);
  settings = readPiSettings(settingsFile);
  expect(settings.defaultProvider, 'defaultProvider removed on clear').toBe(undefined);
  expect(settings.defaultModel, 'defaultModel removed on clear').toBe(undefined);
});

test('unrelated defaultProvider preserved when model is cleared', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const dir = piDirFor(ws);
  mkdirSync(dir, { recursive: true });
  const settingsFile = piSettingsPath(ws);
  writeFileSync(settingsFile, JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-3-opus' }, null, 2));

  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: null }) });
  expect(run.code, `clearing with unrelated provider should succeed:\n${run.combined}`).toBe(0);
  const settings = readPiSettings(settingsFile);
  expect(settings.defaultProvider, 'unrelated defaultProvider preserved').toBe('anthropic');
  expect(settings.defaultModel, 'unrelated defaultModel preserved').toBe('claude-3-opus');
});

test('refuses unparseable settings.json without modifying file', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  mkdirSync(piDirFor(ws), { recursive: true });
  const badSettings = '{\n  "theme": "dark"';
  writeFileSync(piSettingsPath(ws), badSettings);

  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  expect(run.code, 'installer should fail on unparseable settings.json').not.toBe(0);
  expect(readFileSync(piSettingsPath(ws), 'utf8'), 'settings.json remains untouched').toBe(badSettings);
});

test('missing node aborts with clear error message', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), omitNode: true });
  expect(run.code, 'installer should fail when node is missing').not.toBe(0);
  expect(run.combined).toContain('Node.js (>= 22.19) is required to run Pi but was not found on PATH. Install Node.js (>= 22.19) and re-run.');
  expect(!existsSync(piExtensionPath(ws))).toBeTruthy();
});

test('unsupported Node fails before configuration', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), fakeNodeVersion: 'v20.10.0' });
  expect(run.code, `setup should reject unsupported Node:\n${run.combined}`).not.toBe(0);
  expect(run.combined, 'required Node version is reported').toContain('Pi requires Node.js >= 22.19.');
  expect(!existsSync(piExtensionPath(ws))).toBeTruthy();
});

test('API key is never printed to stdout or stderr during setup', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'sentinel key must never be printed to stdout or stderr').not.toContain(SENTINEL_KEY);
});

test('ambient SETUP_API_KEY is not inherited by fake pi CLI', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runShellInstallerWithAmbientKey({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  expect(run.code, `ambient key must not cause fake pi to exit 91:\n${run.combined}`).toBe(0);
});

test('CLI not found runs test installer hook and installs pi', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  expect(run.code, `installer should succeed after install:\n${run.combined}`).toBe(0);
  expect(existsSync(join(ws.home, '.local/bin/pi'))).toBeTruthy();
  expect(existsSync(piExtensionPath(ws))).toBeTruthy();
});

test('CLI not found installs via npm when npm is available', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), withPiInstallHook: false });
  expect(run.code, `npm install should succeed:\n${run.combined}`).toBe(0);
  expect(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim()).toBe('install --global @earendil-works/pi-coding-agent');
});

test('CLI not found fails when installer download fails', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  modelServer.mode = 'installer-html';
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: piConfig(),
    withPiInstallHook: false,
    piInstallerUrl: `${modelServer.url}/install-pi.sh`,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined).toContain('the installer download was HTML');
});

test('fails when pi --version times out', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: piConfig(),
    fakePiVersionSleep: 5,
    timeoutSeconds: 1,
  });
  expect(run.code, 'setup must fail when version times out').not.toBe(0);
  expect(run.combined).toContain('timed out');
});

test('Bash installer body parses under the macOS Bash 3.2 baseline', { timeout: 180_000 }, () => {
  const probe = spawnSync('/bin/bash', ['-n', '-c', ALL_BASH_FRAGMENTS], { encoding: 'utf8' });
  expect(probe.status, `all Bash fragments must parse without syntax errors: ${probe.stderr}`).toBe(0);
  expect(SETUP_BASH_PI, 'echo must not be used in Bash installer; use printf instead').not.toContain('echo ');
});

test('a download that ends before the final main call performs no setup work', { timeout: 180_000 }, () => {
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const fullScript = renderShellPrefix({ agent: 'pi', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration: piConfig(), extensionPath: '/api/setup/test-lease-token/pi.js' }) + shellBody('pi');
  const truncatedScript = fullScript.slice(0, fullScript.lastIndexOf(shellEntry('pi')));
  const scriptPath = join(ws.root, 'truncated.sh');
  writeFileSync(scriptPath, truncatedScript);
  const probe = spawnSync('/bin/bash', [scriptPath], {
    env: { HOME: ws.home, PATH: [ws.binDir, SHIM_BIN].join(':'), TMPDIR: ws.root, SETUP_ENDPOINT: modelServer.url },
    encoding: 'utf8',
  });
  expect(probe.status, 'truncated script defines functions and exits without executing main').toBe(0);
  expect(!existsSync(piExtensionPath(ws))).toBeTruthy();
});

// --- PowerShell Pi Cases ---

test('PowerShell: model set, changed, and cleared updates settings.json', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const settingsFile = piSettingsPath(ws);

  const run1 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  expect(run1.code, `setting model should succeed:\n${run1.combined}`).toBe(0);
  expect(existsSync(settingsFile)).toBeTruthy();
  expect(statSync(settingsFile).mode & 0o777, 'settings.json permissions are 0600').toBe(0o600);
  let settings = readPiSettings(settingsFile);
  expect(settings.defaultProvider).toBe('floway');
  expect(settings.defaultModel).toBe('floway-pi-model-1');

  const run2 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'model-2' }) });
  expect(run2.code, `changing model should succeed:\n${run2.combined}`).toBe(0);
  settings = readPiSettings(settingsFile);
  expect(settings.defaultProvider).toBe('floway');
  expect(settings.defaultModel).toBe('model-2');

  const run3 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: null }) });
  expect(run3.code, `clearing model should succeed:\n${run3.combined}`).toBe(0);
  settings = readPiSettings(settingsFile);
  expect(settings.defaultProvider, 'defaultProvider removed on clear').toBe(undefined);
  expect(settings.defaultModel, 'defaultModel removed on clear').toBe(undefined);
});

test('PowerShell: unrelated defaultProvider preserved when model is cleared', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const dir = piDirFor(ws);
  mkdirSync(dir, { recursive: true });
  const settingsFile = piSettingsPath(ws);
  writeFileSync(settingsFile, JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-3-opus' }, null, 2));

  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: null }) });
  expect(run.code, `clearing with unrelated provider should succeed:\n${run.combined}`).toBe(0);
  const settings = readPiSettings(settingsFile);
  expect(settings.defaultProvider, 'unrelated defaultProvider preserved').toBe('anthropic');
  expect(settings.defaultModel, 'unrelated defaultModel preserved').toBe('claude-3-opus');
});

test('PowerShell: refuses unparseable settings.json without modifying file', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  mkdirSync(piDirFor(ws), { recursive: true });
  const badSettings = '{\n  "theme": "dark"';
  writeFileSync(piSettingsPath(ws), badSettings);

  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig({ model: 'floway-pi-model-1' }) });
  expect(run.code, 'installer should fail on unparseable settings.json').not.toBe(0);
  expect(readFileSync(piSettingsPath(ws), 'utf8'), 'settings.json remains untouched').toBe(badSettings);
});

test('PowerShell: missing node aborts with clear error message', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), omitNode: true });
  expect(run.code, 'installer should fail when node is missing').not.toBe(0);
  expect(run.combined).toContain('Node.js (>= 22.19) is required to run Pi but was not found on PATH. Install Node.js (>= 22.19) and re-run.');
  expect(!existsSync(piExtensionPath(ws))).toBeTruthy();
});

test('PowerShell: unsupported Node fails before configuration', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), fakeNodeVersion: 'v20.10.0' });
  expect(run.code, `setup should reject unsupported Node:\n${run.combined}`).not.toBe(0);
  expect(run.combined, 'required Node version is reported').toContain('Pi requires Node.js >= 22.19.');
  expect(!existsSync(piExtensionPath(ws))).toBeTruthy();
});

test('PowerShell: API key is never printed to stdout or stderr during setup', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'sentinel key must never be printed to stdout or stderr').not.toContain(SENTINEL_KEY);
});

test('PowerShell: ambient SETUP_API_KEY is not inherited by fake pi CLI', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), ambientApiKey: true });
  expect(run.code, `ambient key must not cause fake pi to exit 91:\n${run.combined}`).toBe(0);
});

test('PowerShell: CLI not found runs test installer hook and installs pi', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  expect(run.code, `installer should succeed after install:\n${run.combined}`).toBe(0);
  expect(existsSync(join(ws.home, '.local/bin/pi'))).toBeTruthy();
  expect(existsSync(piExtensionPath(ws))).toBeTruthy();
});

test('PowerShell: CLI not found fails when installer download fails', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-html';
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: piConfig(),
    withPiInstallHook: false,
    piInstallerUrl: `${modelServer.url}/install-pi.ps1`,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined).toContain('the installer download was HTML or empty');
});

test('PowerShell: fails when pi --version times out', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: piConfig(),
    fakePiVersionSleep: 5,
    timeoutSeconds: 1,
  });
  expect(run.code, 'setup must fail when version times out').not.toBe(0);
  expect(run.combined).toContain('`pi --version` timed out');
});

test('local PowerShell installer accepts script content and rejects HTML', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const accepted = makeWorkspace();
  modelServer.mode = 'installer-pi-ps1';
  const success = await runPowerShellInstaller({
    workspace: accepted,
    configuration: piConfig(),
    baseUrl: modelServer.url,
    withPiInstallHook: false,
    piInstallerUrl: `${modelServer.url}/install-pi.ps1`,
  });
  expect(success.code, `a local PowerShell installer should be accepted:\n${success.combined}`).toBe(0);
  expect(existsSync(installerMarker(accepted))).toBeTruthy();

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runPowerShellInstaller({
    workspace: rejected,
    configuration: piConfig(),
    baseUrl: modelServer.url,
    withPiInstallHook: false,
    piInstallerUrl: `${modelServer.url}/install-pi.ps1`,
  });
  expect(failure.code, 'HTML installer response must be rejected').not.toBe(0);
  expect(!existsSync(installerMarker(rejected))).toBeTruthy();
});

test('PowerShell: timed-out installer terminates cleanly', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-pi-ps1';
  const started = Date.now();
  const run = await runPowerShellInstaller({
    workspace: ws,
    configuration: piConfig(),
    baseUrl: modelServer.url,
    withPiInstallHook: false,
    piInstallerUrl: `${modelServer.url}/install-pi.ps1`,
    installerSleep: 12,
    timeoutSeconds: 1,
  });
  expect(run.code, 'timed out installer must fail the agent').not.toBe(0);
  expect(Date.now() - started < 8_000).toBeTruthy();
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
});

test('PowerShell installer body parses without syntax errors', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const body = powerShellBody('pi');
  const entry = powerShellEntry('pi');
  expect(body.trimEnd().endsWith(entry)).toBeTruthy();
  expect(body.lastIndexOf(entry) > body.indexOf('function Set-SetupAgent {')).toBeTruthy();
  const script = renderPowerShellPrefix({
    agent: 'pi',
    apiKey: SENTINEL_KEY,
    apiKeyName: 'Primary key',
    configuration: piConfig({ model: 'm' }),
    extensionPath: '/api/setup/test-lease-token/pi.js',
  }) + body;
  const scriptPath = join(HARNESS_ROOT, 'pi-parse-check.ps1');
  writeFileSync(scriptPath, script);
  const check = `$errs=$null; [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}',[ref]$null,[ref]$errs); if($errs -and $errs.Count -gt 0){ $errs | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 } else { exit 0 }`;
  const result = spawnSync(hostPwsh, ['-NoProfile', '-Command', check], { encoding: 'utf8' });
  expect(result.status, `PowerShell parse errors:\n${result.stdout}${result.stderr}`).toBe(0);
});

test('PowerShell: a download that ends before the final Main call performs no setup work', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const configuration = piConfig();
  const body = powerShellBody('pi');
  const bodyWithoutEntry = body.slice(0, body.lastIndexOf(powerShellEntry('pi')));
  const script = renderPowerShellPrefix({ agent: 'pi', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration, extensionPath: '/api/setup/test-lease-token/pi.js' }) + bodyWithoutEntry;
  const scriptPath = join(ws.root, 'truncated-pi-setup.ps1');
  writeFileSync(scriptPath, script);
  const result = spawnSync(hostPwsh, ['-NoProfile', '-File', scriptPath], {
    encoding: 'utf8',
    env: { HOME: ws.home, PATH: [ws.binDir, SHIM_BIN].join(':'), SETUP_ENDPOINT: modelServer.url },
  });
  expect(result.status, `definitions-only script should exit cleanly:\n${result.stderr}`).toBe(0);
  expect(!existsSync(piExtensionPath(ws))).toBeTruthy();
});

test('installer scripts embed expected URLs and command sequences', { timeout: 180_000 }, () => {
  expect(SETUP_POWERSHELL_PI, 'PowerShell can install pi with npm').toContain('@earendil-works/pi-coding-agent');
  expect(SETUP_POWERSHELL_PI, 'PowerShell uses official install.sh URL').toContain('https://pi.dev/install.sh');
  expect(SETUP_BASH_PI, 'Bash installer specifies the npm package name').toContain('@earendil-works/pi-coding-agent');
  expect(SETUP_BASH_PI, 'Bash installer specifies the official install.sh URL').toContain('https://pi.dev/install.sh');
});

test('real Pi loads the installed extension and discovers changed models without setup', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPiBin) return skip(true, 'real Pi is not available');
  const ws = makeWorkspace();
  writeFileSync(join(ws.binDir, 'pi'), `#!/bin/sh\nexec ${shellLiteral(hostPiBin)} "$@"\n`, { mode: 0o755 });
  const fixture = (id: string): Record<string, unknown> => ({
    id, name: id, provider: 'floway', api: 'openai-responses', baseUrl: `${modelServer.url}/v1`,
    reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
    input: ['text', 'image'], contextWindow: 200000, maxTokens: 32000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  });
  piFixture.models = [fixture('first-model')];
  const install = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), withPiInstallHook: false });
  expect(install.code, install.combined).toBe(0);
  const listModels = () => new Promise<RunResult>((resolve, reject) => {
    const child = spawn(hostPiBin!, ['--list-models', 'floway'], {
      cwd: ws.root,
      env: { ...process.env, HOME: ws.home, PI_CODING_AGENT_DIR: piDirFor(ws), PI_OFFLINE: '1' },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: stdout + stderr }));
  });
  const first = await listModels();
  expect(first.code, first.combined).toBe(0);
  expect(first.stdout).toContain('first-model');
  piFixture.models = [fixture('second-model')];
  const second = await listModels();
  expect(second.code, second.combined).toBe(0);
  expect(second.stdout).toContain('second-model');
  expect(second.stdout).not.toContain('first-model');
  piFixture.models = [];
  const empty = await listModels();
  expect(empty.code, empty.combined).toBe(0);
  expect(empty.stdout).not.toContain('first-model');
  expect(empty.stdout).not.toContain('second-model');
  const requests = modelServer.requests.filter(request => request.path === '/v1/models');
  expect(requests.length >= 3).toBeTruthy();
  for (const request of requests) {
    expect((request.userAgent ?? '').startsWith('pi/1.1.0 (')).toBeTruthy();
    expect(request.authorization, 'discovery authenticates as the selected API key').toBe(`Bearer ${SENTINEL_KEY}`);
    expect(request.endpoint, 'public configured endpoint accompanies authenticated discovery').toBe(modelServer.url);
  }
  expect(first.combined + second.combined + empty.combined).not.toContain(SENTINEL_KEY);
});

test('real Pi SDK refresh replaces and removes models while retaining full capabilities', { timeout: 180_000 }, async ({ skip }) => {
  const sdkPath = process.env.PI_SDK_PATH;
  if (!sdkPath) return skip(true, 'PI_SDK_PATH is not configured');
  const ws = makeWorkspace();
  placeFakePi(ws.binDir);
  const fixture = (id: string): Record<string, unknown> => ({
    id, name: id, provider: 'floway', api: 'openai-responses', baseUrl: `${modelServer.url}/v1`,
    reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
    input: ['text', 'image'], contextWindow: 200000, maxTokens: 32000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    headers: { 'x-model-capability': id, 'accept-encoding': 'identity' }, compat: { supportsDeveloperRole: false },
  });
  piFixture.models = [fixture('first-model'), { ...fixture('budget-model'), api: 'anthropic-messages', baseUrl: modelServer.url, thinkingBudgets: { minimal: 4096, low: 4096, medium: 8192, high: 10000 }, effortOverrides: { low: 'fast' } }, { ...fixture('mandatory-model'), thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null } }, ...['adaptive-model', 'adaptive-mandatory-model'].map(id => ({ ...fixture(id), api: 'anthropic-messages', baseUrl: modelServer.url, thinkingLevelMap: { off: id === 'adaptive-model' ? 'off' : null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null }, compat: { forceAdaptiveThinking: true }, payloadRemovals: [['output_config', 'effort']] }))];
  const refreshedModel = {
    ...fixture('second-model'),
    inputLimits: { images: { resize: { maxWidth: 1234, maxHeight: 987, maxBytes: 345678, jpegQuality: 72 } } },
    promptCache: { short: 97, long: 193 },
    samplingParams: { temperature: 0.4 },
    samplingParamsByThinkingLevel: { high: { top_p: 0.8 } },
    compat: { supportsStrictMode: true, supportsMidConvoSystemMessages: true },
    serverAddedMetadata: { version: 2, nested: ['unchanged'] },
  };
  piFixture.catalogs = [[refreshedModel], []];
  piFixture.status = 200;
  const install = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig() });
  expect(install.code, install.combined).toBe(0);
  const installedExtension = readFileSync(piExtensionPath(ws), 'utf8');
  const runner = join(ws.root, 'pi-sdk.mjs');
  writeFileSync(runner, `
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const authPath = join(process.env.PI_CODING_AGENT_DIR, 'auth.json');
const credentials = JSON.parse(readFileSync(authPath, 'utf8'));
process.env.FLOWAY_PI_FIXTURE_KEY = ${JSON.stringify(SENTINEL_KEY)};
credentials.floway.key = '!printf %s "$FLOWAY_PI_FIXTURE_KEY"';
writeFileSync(authPath, JSON.stringify(credentials));
const { createAgentSession, SessionManager } = await import(pathToFileURL(process.env.PI_SDK_PATH).href);
const { session, extensionsResult } = await createAgentSession({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: SessionManager.inMemory(process.cwd()), noTools: 'all' });
assert.deepEqual(extensionsResult.errors, []);
assert.ok(session.modelRuntime.getModels('openai').length > 0, 'original OpenAI provider remains available');
const runtime = session.modelRuntime;
const models = () => runtime.getModels().filter(model => model.provider === 'floway');
const snapshots = [models()];
const context = { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] };
for (const id of ['first-model', 'budget-model', 'mandatory-model', 'adaptive-model', 'adaptive-mandatory-model']) {
  const response = await runtime.completeSimple(runtime.getModel('floway', id), context, { reasoning: id.startsWith('adaptive') ? 'high' : 'low', headers: { 'x-request-capability': id, 'aCcEpT-EnCoDiNg': 'identity' }, onPayload: payload => { if (id.startsWith('adaptive')) payload.output_config = { ...payload.output_config, format: { type: 'json_schema', schema: { type: 'object' } } }; } });
  assert.equal(response.stopReason, 'stop', response.errorMessage);
}
const budgetModel = runtime.getModel('floway', 'budget-model');
const altered = await runtime.completeSimple(budgetModel, context, { reasoning: 'low', onPayload: payload => { payload.output_config.effort = 'request-only'; } });
assert.equal(altered.stopReason, 'stop', altered.errorMessage);
assert.equal(budgetModel.effortOverrides.low, 'fast', 'request customization must not mutate the catalog');
const repeated = await runtime.completeSimple(budgetModel, context, { reasoning: 'low' });
assert.equal(repeated.stopReason, 'stop', repeated.errorMessage);
credentials.floway.key = '$!literal$$VALUE';
writeFileSync(authPath, JSON.stringify(credentials));
assert.equal((await runtime.getAuth('floway')).auth.apiKey, '!literal$VALUE');
credentials.floway.key = '$FLOWAY_PI_FIXTURE_KEY';
process.env.FLOWAY_PI_FIXTURE_KEY = 'rotated-key';
writeFileSync(authPath, JSON.stringify(credentials));
assert.equal((await runtime.getAuth('floway')).auth.apiKey, 'rotated-key');
for (let index = 0; index < 2; index++) {
  await fetch(process.env.PI_FIXTURE_URL + '/test/pi/advance');
  const result = await runtime.refresh({ providers: ['floway'], allowNetwork: true });
  assert.equal(result.errors.size, 0);
  snapshots.push(models());
  if (index === 0) {
    const expected = ${JSON.stringify(refreshedModel)};
    const response = await runtime.completeSimple(runtime.getModel('floway', 'second-model'), context, { reasoning: 'high', onPayload: (_payload, model) => { assert.deepEqual(JSON.parse(JSON.stringify(model)), expected); } });
    assert.equal(response.stopReason, 'stop', response.errorMessage);
  }
}
await fetch(process.env.PI_FIXTURE_URL + '/test/pi/fail');
const failure = await runtime.refresh({ providers: ['floway'], allowNetwork: true });
assert.match(failure.errors.get('floway').message, /^Floway model discovery failed: HTTP 502:/);
assert.deepEqual(models(), []);
session.dispose();
process.stdout.write(JSON.stringify(snapshots));
`);
  const result = await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [runner], {
      cwd: ws.root,
      env: { PATH: process.env.PATH, HOME: ws.home, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: piDirFor(ws), PI_SDK_PATH: sdkPath, PI_FIXTURE_URL: modelServer.url },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: stdout + stderr }));
  });
  piFixture.status = 200;
  expect(result.code, result.combined).toBe(0);
  const snapshots = JSON.parse(result.stdout) as Record<string, unknown>[][];
  expect(snapshots[0]?.[0]?.id).toBe('first-model');
  expect(snapshots[1]?.[0]?.id).toBe('second-model');
  expect(snapshots[1]?.length, 'refresh replaces the old catalog').toBe(1);
  expect(snapshots[2]?.length, 'empty catalogs remove every model').toBe(0);
  expect(JSON.stringify(snapshots[1]?.[0]), 'server-added metadata survives the native registry and request bridge').toBe(JSON.stringify(refreshedModel));
  expect(readFileSync(piExtensionPath(ws), 'utf8'), 'metadata refresh does not rewrite the installed extension').toBe(installedExtension);
  expect(modelServer.requests.some(request => request.path === '/v1/models' && request.authorization === 'Bearer rotated-key')).toBeTruthy();
  expect(result.combined).not.toContain(SENTINEL_KEY);
  const responses = modelServer.requests.find(request => request.path === '/v1/responses');
  const messages = modelServer.requests.find(request => request.path === '/v1/messages');
  for (const request of modelServer.requests.filter(request => ['/v1/models', '/v1/responses', '/v1/messages'].includes(request.path))) {
    expect(request.headers['accept-encoding'], 'discovery and both native APIs negotiate supported response compression').toBe(typeof zlib.createZstdDecompress === 'function' ? 'gzip, deflate, br, zstd' : 'gzip, deflate, br');
  }
  for (const request of [responses!, messages!]) {
    expect(request.headers['x-model-capability'], 'model headers remain intact').toBe(request.body!.model as string);
    expect(request.headers['x-request-capability'], 'request headers remain intact').toBe(request.body!.model as string);
  }
  expect(JSON.stringify(responses?.body?.reasoning), 'Responses effort reaches the adapter').toBe(JSON.stringify({ effort: 'low', summary: 'auto' }));
  const thinking = messages?.body?.thinking as { type: string; budget_tokens: number };
  expect(thinking.type, 'budget enables native Anthropic thinking').toBe('enabled');
  expect(thinking.budget_tokens, 'server-derived budget reaches the native Anthropic adapter').toBe(4096);
  expect(JSON.stringify(messages?.body?.output_config), 'combined budget and declared open-string effort survive adapter projection').toBe(JSON.stringify({ effort: 'fast' }));
  const budgetRequests = modelServer.requests.filter(request => request.body?.model === 'budget-model');
  expect((budgetRequests[1]?.body?.output_config as { effort: string }).effort, 'the native payload callback can customize one request').toBe('request-only');
  expect((budgetRequests[2]?.body?.output_config as { effort: string }).effort, 'subsequent requests use the unchanged model metadata').toBe('fast');
  const mandatory = modelServer.requests.find(request => request.body?.model === 'mandatory-model');
  expect(mandatory?.body?.reasoning, 'uncontrollable mandatory reasoning does not fabricate an effort or off request').toBe(undefined);
  for (const id of ['adaptive-model', 'adaptive-mandatory-model']) {
    const request = modelServer.requests.find(request => request.body?.model === id);
    const thinking = request?.body?.thinking as { type: string };
    expect(thinking.type, 'adaptive-only models enable their advertised native mode').toBe('adaptive');
    const outputConfig = request?.body?.output_config as { effort?: string; format?: unknown };
    expect(outputConfig.effort, 'no unadvertised effort is fabricated').toBe(undefined);
    expect(outputConfig.format !== undefined).toBeTruthy();
  }
});
