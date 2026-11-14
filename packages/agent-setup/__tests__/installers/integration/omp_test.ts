import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, test } from 'vitest';

import { FAKE_OMP, HARNESS_ROOT, OMP_PLUGIN_NAME, SENTINEL_KEY, SHIM_BIN, hostOmpBin, hostPwsh, installerMarker, makeWorkspace, modelServer, ompBackupFiles, ompConfig, ompConfigPath, ompDirFor, ompExtensionPath, ompModelsPath, ompPackagePath, ompPluginLinkPath, ompPluginLockPath, ompPluginsDirFor, ompStagedFiles, placeFakeNpm, placeFakeOmp, powerShellBody, powerShellEntry, readOmpConnections, readOmpPluginLock, runPowerShellInstaller, runShellInstaller, runShellInstallerWithAmbientKey, seedOmpPlugin, shellBody, shellEntry, shellLiteral } from './harness';
import type { OMP_PLUGIN_MANIFEST, OmpPluginLock, RunResult } from './harness';
import { renderPowerShellPrefix, renderShellPrefix } from '../../../src/render.ts';
import { SETUP_BASH_OMP, SETUP_NODE_OMP_EXTENSION, SETUP_POWERSHELL_OMP } from '../../../src/script-assets.generated.ts';

test('fresh install downloads a protected JS extension without model or role configuration', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  modelServer.reset();
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  expect(run.code, `fresh install should succeed:\n${run.combined}`).toBe(0);
  expect(run.stdout, 'completion notice emitted').toContain('==> Completed Agent Setup: oh-my-pi');
  const extensionPath = ompExtensionPath(ws);
  expect(existsSync(extensionPath)).toBeTruthy();
  expect(statSync(extensionPath).mode & 0o777, 'extension permissions are 0600').toBe(0o600);
  expect(readFileSync(extensionPath, 'utf8'), 'installed source matches the leased extension').toBe(SETUP_NODE_OMP_EXTENSION);
  const manifest = JSON.parse(readFileSync(ompPackagePath(ws), 'utf8')) as typeof OMP_PLUGIN_MANIFEST;
  expect(manifest.name, 'package uses the native Floway plugin name').toBe(OMP_PLUGIN_NAME);
  expect(manifest.version, 'plugin package has the declared version').toBe('1.0.0');
  expect(manifest.type, 'plugin package is an ES module').toBe('module');
  expect(manifest.omp.extensions[0], 'plugin manifest exposes the extension entrypoint').toBe('index.js');
  const paths = JSON.parse(readFileSync(join(ws.root, 'omp-setup-paths-record.jsonl'), 'utf8')) as { agentDir: string; pluginsDir: string };
  expect(paths.agentDir, 'default agent directory is discovered').toBe(join(ws.home, '.omp/agent'));
  expect(paths.pluginsDir, 'default plugin directory is discovered independently').toBe(join(ws.home, '.omp/plugins'));
  const probeCommand = readFileSync(join(ws.root, 'omp-probe-commands.txt'), 'utf8').trim();
  expect(probeCommand, 'probe loads only the explicit extension without starting a model session').toContain('models --no-extensions -e ');
  const pluginLink = ompPluginLinkPath(ws);
  expect(lstatSync(pluginLink).isSymbolicLink()).toBeTruthy();
  expect(realpathSync(pluginLink), 'native plugin link targets the installed package').toBe(realpathSync(join(ompPluginsDirFor(ws), 'floway')));
  expect(readFileSync(join(ws.root, 'omp-plugin-commands.txt'), 'utf8').trim(), 'installer registers the source through omp plugin link').toBe(`plugin link ${join(ompPluginsDirFor(ws), 'floway')}`);
  const lockPath = ompPluginLockPath(ws);
  const pluginLock = readOmpPluginLock(ws);
  const registration = pluginLock.plugins?.[OMP_PLUGIN_NAME] as { version?: string; enabledFeatures?: unknown; enabled?: boolean } | undefined;
  expect(registration !== undefined).toBeTruthy();
  expect(registration?.version, 'native plugin registration uses the package version').toBe('1.0.0');
  expect(registration?.enabledFeatures, 'native plugin registration keeps default feature selection').toBe(null);
  expect(registration?.enabled, 'native plugin registration enables Floway').toBe(true);
  expect(statSync(lockPath).mode & 0o777, 'plugin settings and credentials are private').toBe(0o600);
  expect(readOmpConnections(ws)[0]?.endpoint, 'connection settings live in the native plugin lock').toBe(modelServer.url);
  expect(readOmpConnections(ws)[0]?.apiKey, 'connection credentials live in the native plugin lock').toBe(SENTINEL_KEY);
  expect(!existsSync(ompConfigPath(ws))).toBeTruthy();
  expect(!existsSync(ompModelsPath(ws))).toBeTruthy();
});

for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
  test(`${platform}: preserves native plugin settings when linking Floway`, { timeout: 180_000 }, async () => {
    const ws = makeWorkspace();
    placeFakeOmp(ws.binDir);
    mkdirSync(ompPluginsDirFor(ws), { recursive: true });
    const otherPlugin = { enabled: false, preferences: { accent: 'violet' } };
    const existingFlowayConnection = { provider: 'existing-floway', endpoint: 'https://existing.example', apiKey: 'existing-key' };
    const priorLock: OmpPluginLock = {
      plugins: { '@example/theme': { version: '2.0.0', source: 'registry' } },
      settings: {
        '@example/theme': otherPlugin,
        [OMP_PLUGIN_NAME]: { theme: 'dark', custom: { retained: true }, connections: [existingFlowayConnection] },
      },
    };
    writeFileSync(ompPluginLockPath(ws), `${JSON.stringify(priorLock, null, 2)}\n`, { mode: 0o644 });

    const run = await install({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
    expect(run.code, run.combined).toBe(0);

    const lock = readOmpPluginLock(ws);
    expect(JSON.stringify(lock.plugins?.['@example/theme']), 'other plugin registration is preserved').toBe(JSON.stringify(priorLock.plugins?.['@example/theme']));
    expect(JSON.stringify(lock.settings?.['@example/theme']), 'other plugin settings are preserved').toBe(JSON.stringify(otherPlugin));
    const flowaySettings = lock.settings?.[OMP_PLUGIN_NAME] as { theme?: string; custom?: unknown } | undefined;
    expect(flowaySettings?.theme, 'unrelated Floway settings are preserved').toBe('dark');
    expect(JSON.stringify(flowaySettings?.custom), 'nested Floway settings are preserved').toBe(JSON.stringify({ retained: true }));
    expect(lock.plugins?.[OMP_PLUGIN_NAME] !== undefined).toBeTruthy();
    expect(lstatSync(ompPluginLinkPath(ws)).isSymbolicLink()).toBeTruthy();
    expect(realpathSync(ompPluginLinkPath(ws)), 'the package link resolves to the installed source').toBe(realpathSync(join(ompPluginsDirFor(ws), 'floway')));
    expect(readOmpConnections(ws).length, 'existing connections remain alongside the new connection').toBe(2);
    expect(readOmpConnections(ws)[0]?.provider, 'existing connection order is retained').toBe('existing-floway');
    expect(statSync(ompPluginLockPath(ws)).mode & 0o777, 'plugin settings are protected after update').toBe(0o600);
  });
}

test('model set, changed, and cleared updates config.yml', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const configFile = ompConfigPath(ws);

  const run1 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'gpt-4o' }) });
  expect(run1.code, `setting model should succeed:\n${run1.combined}`).toBe(0);
  expect(existsSync(configFile)).toBeTruthy();
  const expectedConfig1 = [
    'modelRoles:',
    '  default: "floway/gpt-4o"',
    '',
  ].join('\n');
  expect(readFileSync(configFile, 'utf8'), 'exact config shape when set').toBe(expectedConfig1);

  const run2 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: "claude-3-5:special'quote" }) });
  expect(run2.code, `changing model should succeed:\n${run2.combined}`).toBe(0);
  const expectedConfig2 = [
    'modelRoles:',
    '  default: "floway/claude-3-5:special\'quote"',
    '',
  ].join('\n');
  expect(readFileSync(configFile, 'utf8'), 'exact config shape when changed with escaping').toBe(expectedConfig2);

  const run3 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: null }) });
  expect(run3.code, `clearing model should succeed:\n${run3.combined}`).toBe(0);
  expect(!existsSync(configFile) || readFileSync(configFile, 'utf8') === '').toBeTruthy();
});

test('idempotent re-run produces no diff and prunes backups', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run1 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'gpt-4o' }) });
  expect(run1.code, `first run should succeed:\n${run1.combined}`).toBe(0);
  const extension1 = readFileSync(ompExtensionPath(ws), 'utf8');
  const config1 = readFileSync(ompConfigPath(ws), 'utf8');

  const run2 = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'gpt-4o' }) });
  expect(run2.code, `second run should succeed:\n${run2.combined}`).toBe(0);
  expect(readFileSync(ompExtensionPath(ws), 'utf8'), 'extension source identical').toBe(extension1);
  expect(readFileSync(ompConfigPath(ws), 'utf8'), 'config.yml identical').toBe(config1);
  expect(ompBackupFiles(dirname(ompExtensionPath(ws)), 'index.js').length, 'no extension backups remain').toBe(0);
  expect(ompBackupFiles(dirname(ompPackagePath(ws)), 'package.json').length, 'no manifest backups remain').toBe(0);
  expect(ompBackupFiles(ompPluginsDirFor(ws), 'omp-plugins.lock.json').length, 'no plugin settings backups remain').toBe(0);
  expect(ompBackupFiles(ompDirFor(ws), 'config.yml').length, 'no config backups remain').toBe(0);
});

test('preserves unrelated providers, comments, roles, CRLF, and missing trailing newline', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });

  const priorModels = '# User comments\r\nproviders:\r\n  anthropic:\r\n    baseUrl: https://api.anthropic.com\r\n    apiKey: ant-secret';
  const priorConfig = '# Custom config\r\nmodelRoles:\r\n  plan: anthropic/claude-3-opus';
  writeFileSync(ompModelsPath(ws), priorModels);
  writeFileSync(ompConfigPath(ws), priorConfig);

  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'test-model' }) });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);

  const modelsText = readFileSync(ompModelsPath(ws), 'utf8');
  expect(modelsText, 'comments preserved in models.yml').toContain('# User comments');
  expect(modelsText, 'unrelated provider preserved').toContain('anthropic:');
  expect(modelsText, 'unrelated provider keys preserved').toContain('apiKey: ant-secret');
  expect(modelsText, 'no provider configuration is inserted').not.toContain('floway:');
  expect(modelsText.includes('\r\n')).toBeTruthy();

  const configText = readFileSync(ompConfigPath(ws), 'utf8');
  expect(configText, 'comments preserved in config.yml').toContain('# Custom config');
  expect(configText, 'unrelated role preserved').toContain('plan: anthropic/claude-3-opus');
  expect(configText, 'managed default inserted').toContain('default: "floway/test-model"');
  expect(configText.includes('\r\n')).toBeTruthy();

  const runClear = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: null }) });
  expect(runClear.code, `clearing should succeed:\n${runClear.combined}`).toBe(0);

  const configCleared = readFileSync(ompConfigPath(ws), 'utf8');
  expect(configCleared, 'comments preserved after clear').toContain('# Custom config');
  expect(configCleared, 'modelRoles header preserved').toContain('modelRoles:');
  expect(configCleared, 'unrelated user role preserved').toContain('plan: anthropic/claude-3-opus');
  expect(configCleared, 'managed default key removed').not.toContain('default:');
});

test('refuses config.yml containing tabs without modifying file', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const badContent = 'modelRoles:\n\tdefault: foo\n';
  writeFileSync(ompConfigPath(ws), badContent);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'foo' }) });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'error mentions tabs').toContain('tabs found in');
  expect(readFileSync(ompConfigPath(ws), 'utf8'), 'file unmodified').toBe(badContent);
});

test('refuses flow-style modelRoles mapping in config.yml without modifying file', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const badContent = 'modelRoles: {}\n';
  writeFileSync(ompConfigPath(ws), badContent);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'foo' }) });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'unsafe mapping is reported').toContain('modelRoles must be a single block-style YAML mapping');
  expect(readFileSync(ompConfigPath(ws), 'utf8'), 'file unmodified').toBe(badContent);
});

test('refuses an unmanaged extension without modifying it', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(dirname(ompExtensionPath(ws)), { recursive: true });
  const badContent = 'providers:\n  floway:\n    baseUrl: https://custom.example.com\n';
  writeFileSync(ompExtensionPath(ws), badContent);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'error mentions unmanaged floway provider').toContain('existing unmanaged Floway extension found');
  expect(readFileSync(ompExtensionPath(ws), 'utf8'), 'file unmodified').toBe(badContent);
});

for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
  test(`${platform}: preserves an unmanaged plugin with a different extension entrypoint`, { timeout: 180_000 }, async () => {
    const ws = makeWorkspace();
    placeFakeOmp(ws.binDir);
    mkdirSync(dirname(ompPackagePath(ws)), { recursive: true });
    const manifest = '{"name":"custom-plugin","omp":{"extensions":["custom.js"]}}';
    const entrypoint = join(dirname(ompPackagePath(ws)), 'custom.js');
    writeFileSync(ompPackagePath(ws), manifest);
    writeFileSync(entrypoint, 'export default () => {};');
    const run = await install({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
    expect(run.code, 'unmanaged plugin setup must fail').not.toBe(0);
    expect(readFileSync(ompPackagePath(ws), 'utf8'), 'manifest preserved').toBe(manifest);
    expect(readFileSync(entrypoint, 'utf8'), 'native extension entrypoint preserved').toBe('export default () => {};');
    expect(!existsSync(ompExtensionPath(ws))).toBeTruthy();
    expect(!existsSync(ompPluginLockPath(ws))).toBeTruthy();
  });

  test(`${platform}: rejects a non-object plugin settings root without modifying it`, { timeout: 180_000 }, async () => {
    const ws = makeWorkspace();
    placeFakeOmp(ws.binDir);
    mkdirSync(ompPluginsDirFor(ws), { recursive: true });
    const badContent = '[{}]\n';
    writeFileSync(ompPluginLockPath(ws), badContent, { mode: 0o600 });

    const run = await install({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
    expect(run.code, 'array root must fail setup').not.toBe(0);
    expect(run.stdout, 'invalid lock data cannot complete setup').not.toContain('==> Completed Agent Setup: oh-my-pi');
    expect(readFileSync(ompPluginLockPath(ws), 'utf8'), 'invalid lock file remains byte for byte unchanged').toBe(badContent);
    expect(!existsSync(ompExtensionPath(ws))).toBeTruthy();
    expect(!existsSync(ompPluginLinkPath(ws))).toBeTruthy();
    expect(ompStagedFiles(ompPluginsDirFor(ws)).length, 'invalid lock data leaves no stage files').toBe(0);
  });
}

test('refuses YAML anchors, aliases, or merge keys touching modelRoles in config.yml', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const badContent = 'modelRoles: &r\n  plan: claude\n';
  writeFileSync(ompConfigPath(ws), badContent);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'foo' }) });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'unsafe mapping is reported').toContain('without aliases');
  expect(readFileSync(ompConfigPath(ws), 'utf8'), 'file unmodified').toBe(badContent);
});

test('an explicit default replaces the previous provider while preserving other roles', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const before = '# Preferences\r\nmodelRoles: # startup\r\n    default: openai/gpt-4o # default choice\r\n    plan: anthropic/claude\r\ntheme: dark';
  writeFileSync(ompConfigPath(ws), before);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'my-model' }) });
  expect(run.code, run.combined).toBe(0);
  expect(readFileSync(ompConfigPath(ws), 'utf8')).toBe(before.replace('openai/gpt-4o', '"floway/my-model"'));
});

test('rollback restores the prior plugin registration and settings after link failure', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const priorContent = SETUP_NODE_OMP_EXTENSION;
  const priorLock: OmpPluginLock = {
    plugins: { [OMP_PLUGIN_NAME]: { version: '1.0.0', enabledFeatures: null, enabled: false }, '@example/theme': { version: '2.0.0' } },
    settings: { [OMP_PLUGIN_NAME]: { theme: 'dark', connections: [{ provider: 'floway', endpoint: 'https://before.example', apiKey: 'old-key' }] }, '@example/theme': { enabled: true, color: 'violet' } },
  };
  seedOmpPlugin(ws, priorLock, priorContent);
  const priorLockText = readFileSync(ompPluginLockPath(ws), 'utf8');
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), fakeOmpLinkFailure: 'unlink' });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'failure occurs after native registration updates and link removal').toContain('fake omp plugin link removed the native link and injected a failure');
  expect(run.combined, 'plugin link failure enters rollback').toContain('oh-my-pi applying changes failed; rolling back configuration.');
  expect(existsSync(join(ws.root, 'omp-plugin-commands.txt'))).toBeTruthy();
  expect(readFileSync(ompExtensionPath(ws), 'utf8'), 'extension restored to original content').toBe(priorContent);
  expect(readFileSync(ompPluginLockPath(ws), 'utf8'), 'native registration and plugin settings are restored byte for byte').toBe(priorLockText);
  expect(realpathSync(ompPluginLinkPath(ws)), 'native link is restored to the Floway package').toBe(realpathSync(join(ompPluginsDirFor(ws), 'floway')));
  expect(ompStagedFiles(ompPluginsDirFor(ws)).length, 'no plugin stage files left behind').toBe(0);
});

test('rollback restore failure preserves backup file and warns operator', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const priorContent = SETUP_NODE_OMP_EXTENSION;
  seedOmpPlugin(ws, { plugins: { [OMP_PLUGIN_NAME]: { version: '1.0.0', enabledFeatures: null, enabled: false } }, settings: { [OMP_PLUGIN_NAME]: { connections: [] } } }, priorContent);
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpFailConfig: true,
    fakeRestoreFailure: true,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'fault reached after successful extension staging').toContain('oh-my-pi simulated failure; rolling back configuration.');
  expect(run.combined, 'rollback warning names restore failure').toContain('could not restore');
  expect(run.combined, 'operator guidance emitted').toContain('restore it by hand');
  const preservedBackups = ompBackupFiles(dirname(ompExtensionPath(ws)), 'index.js').length + ompBackupFiles(dirname(ompPackagePath(ws)), 'package.json').length;
  expect(preservedBackups > 0).toBeTruthy();
});

for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
  test(`${platform}: removes a newly registered plugin after link failure`, { timeout: 180_000 }, async () => {
    const ws = makeWorkspace();
    placeFakeOmp(ws.binDir);
    mkdirSync(ompPluginsDirFor(ws), { recursive: true });
    const priorLock: OmpPluginLock = {
      metadata: { schema: 1 },
      plugins: { '@example/theme': { version: '2.0.0', source: 'registry' } },
      settings: { '@example/theme': { enabled: true, color: 'blue' } },
    };
    writeFileSync(ompPluginLockPath(ws), `${JSON.stringify(priorLock, null, 2)}\n`, { mode: 0o600 });
    const priorLockText = readFileSync(ompPluginLockPath(ws), 'utf8');

    const run = await install({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), fakeOmpLinkFailure: 'after' });
    expect(run.code, 'simulated native link failure exits nonzero').not.toBe(0);
    expect(run.combined, 'the fake mutates the registry and creates the link before failing').toContain('fake omp plugin link completed and injected a failure');
    expect(run.combined, 'plugin link failure enters rollback').toContain('oh-my-pi applying changes failed; rolling back configuration.');
    expect(readFileSync(ompPluginLockPath(ws), 'utf8'), 'previous plugin registrations and settings are restored').toBe(priorLockText);
    expect(readOmpPluginLock(ws).plugins?.[OMP_PLUGIN_NAME], 'Floway registration is removed').toBe(undefined);
    const pluginScope = dirname(ompPluginLinkPath(ws));
    expect(!existsSync(pluginScope) || !readdirSync(pluginScope).includes('omp')).toBeTruthy();
    expect(!existsSync(ompExtensionPath(ws))).toBeTruthy();
    expect(!existsSync(ompPackagePath(ws))).toBeTruthy();
    expect(ompStagedFiles(ompPluginsDirFor(ws)).length, 'no plugin stage files remain').toBe(0);
  });
}

test('resolves agent directory from the native probe', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const customDir = join(ws.home, 'from-native-probe');
  const customPluginsDir = join(ws.home, 'independent-plugin-root');
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpAgentDir: customDir,
    fakeOmpPluginsDir: customPluginsDir,
  });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);
  const paths = JSON.parse(readFileSync(join(ws.root, 'omp-setup-paths-record.jsonl'), 'utf8')) as { agentDir: string; pluginsDir: string };
  expect(paths.agentDir, 'native probe preserves the native agent directory').toBe(customDir);
  expect(paths.pluginsDir, 'native probe can resolve an independent plugin root').toBe(customPluginsDir);
  expect(existsSync(ompExtensionPath(ws, 'independent-plugin-root'))).toBeTruthy();
});

test('propagates native probe failure without guessing the agent directory', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const customDir = join(ws.home, 'from-pi-env-dir');
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpProbeFailure: true,
    piCodingAgentDir: customDir,
  });
  expect(run.code).not.toBe(0);
  expect(run.combined).toContain('test native path probe failure');
  expect(!existsSync(customDir)).toBeTruthy();
  expect(!existsSync(join(ws.root, 'omp-setup-paths-record.jsonl'))).toBeTruthy();
});

test('resolves agent directory from OMP_PROFILE and ignores PI_CODING_AGENT_DIR', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const ignoredDir = join(ws.home, 'ignored-pi-env-dir');
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpAgentDir: join(ws.home, '.omp/profiles/work/agent'),
    fakeOmpPluginsDir: join(ws.home, '.omp/profiles/work/plugins'),
    ompProfile: 'work',
    piCodingAgentDir: ignoredDir,
  });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);
  const paths = JSON.parse(readFileSync(join(ws.root, 'omp-setup-paths-record.jsonl'), 'utf8')) as { agentDir: string; pluginsDir: string };
  expect(paths.agentDir, 'profile agent directory is discovered').toBe(join(ws.home, '.omp/profiles/work/agent'));
  expect(paths.pluginsDir, 'profile plugin directory is discovered').toBe(join(ws.home, '.omp/profiles/work/plugins'));
  expect(existsSync(ompExtensionPath(ws, '.omp/profiles/work/plugins'))).toBeTruthy();
  expect(!existsSync(ignoredDir)).toBeTruthy();
});

test('API key is never printed to stdout or stderr during setup', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'the API key must never be printed to stdout or stderr').not.toContain(SENTINEL_KEY);
});

test('ambient SETUP_API_KEY is not inherited by fake omp CLI', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runShellInstallerWithAmbientKey({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  expect(run.code, `ambient key run should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'subprocesses must not inherit SETUP_API_KEY').not.toContain('fake omp inherited the setup API key');
});

test('CLI not found runs test installer hook and installs omp', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), withOmpInstallHook: true });
  expect(run.code, `hook installation should succeed:\n${run.combined}`).toBe(0);
  expect(existsSync(join(ws.home, '.local/bin/omp'))).toBeTruthy();
  expect(run.stdout, 'reports test installer invocation').toContain('oh-my-pi CLI not found; running the test installer');
  expect(existsSync(ompExtensionPath(ws))).toBeTruthy();
});

test('CLI not found installs via npm when npm is available', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), withOmpInstallHook: false });
  expect(run.code, `npm installation should succeed:\n${run.combined}`).toBe(0);
  expect(run.stdout, 'reports npm installation').toContain('oh-my-pi CLI not found; installing with npm');
  expect(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'npm receives the official global package').toBe('install --global @oh-my-pi/pi-coding-agent');
});

test('CLI not found fails when installer download fails', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    withOmpInstallHook: false,
    ompInstallerUrl: `${modelServer.url}/nonexistent`,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'reports download failure').toContain('could not download the installer');
});

test('warns when multiple omp installations are detected', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const localBin = join(ws.home, '.local/bin');
  mkdirSync(localBin, { recursive: true });
  writeFileSync(join(localBin, 'omp'), FAKE_OMP, { mode: 0o755 });
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'warns about multiple CLIs').toContain('multiple oh-my-pi installations detected');
});

test('fails when omp --version times out', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpVersionSleep: 5,
    timeoutSeconds: 1,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'reports version command timeout').toContain('`omp --version` timed out');
});

test('Bash installer body parses under the macOS Bash 3.2 baseline', { timeout: 180_000 }, async () => {
  const body = shellBody('omp');
  const entry = shellEntry('omp');
  expect(body.trimEnd().endsWith(entry)).toBeTruthy();
  expect(body.lastIndexOf(entry) > body.indexOf('configure_agent() {')).toBeTruthy();
  const script = renderShellPrefix({ extensionPath: '/omp.js', agent: 'omp', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration: ompConfig({ model: 'm' }) }) + body;
  const scriptPath = join(HARNESS_ROOT, 'omp-syntax-check.sh');
  writeFileSync(scriptPath, script);
  const result = spawnSync('/bin/bash', ['-n', scriptPath], { encoding: 'utf8' });
  expect(result.status, `/bin/bash -n reported a syntax error:\n${result.stderr}`).toBe(0);
});

test('a download that ends before the final main call performs no setup work', { timeout: 180_000 }, () => {
  const ws = makeWorkspace();
  const configuration = ompConfig();
  const body = shellBody('omp');
  const bodyWithoutEntry = body.slice(0, body.lastIndexOf(shellEntry('omp')));
  const script = renderShellPrefix({ extensionPath: '/omp.js', agent: 'omp', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration }) + bodyWithoutEntry;
  const scriptPath = join(ws.root, 'truncated-omp-setup.sh');
  writeFileSync(scriptPath, script);
  const result = spawnSync('/bin/bash', [scriptPath], {
    encoding: 'utf8',
    env: { HOME: ws.home, PATH: [ws.binDir, SHIM_BIN].join(':'), SETUP_ENDPOINT: modelServer.url },
  });
  expect(result.status, `definitions-only script should exit cleanly:\n${result.stderr}`).toBe(0);
  expect(result.stdout, 'definitions-only script prints nothing').toBe('');
  expect(!existsSync(ompExtensionPath(ws))).toBeTruthy();
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
});

// --- omp PowerShell parse + execution ---------------------------------------

test('PowerShell: fresh install downloads a protected JS extension without model or role configuration', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  modelServer.reset();
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  expect(run.code, `fresh install should succeed:\n${run.combined}`).toBe(0);
  expect(run.stdout, 'completion notice emitted').toContain('==> Completed Agent Setup: oh-my-pi');
  const extensionPath = ompExtensionPath(ws);
  expect(existsSync(extensionPath)).toBeTruthy();
  expect(statSync(extensionPath).mode & 0o777, 'extension permissions are 0600').toBe(0o600);
  expect(readFileSync(extensionPath, 'utf8'), 'installed source matches the leased extension').toBe(SETUP_NODE_OMP_EXTENSION);
  const manifest = JSON.parse(readFileSync(ompPackagePath(ws), 'utf8')) as typeof OMP_PLUGIN_MANIFEST;
  expect(manifest.name, 'package uses the native Floway plugin name').toBe(OMP_PLUGIN_NAME);
  expect(manifest.version, 'plugin package has the declared version').toBe('1.0.0');
  expect(manifest.type, 'plugin package is an ES module').toBe('module');
  expect(manifest.omp.extensions[0], 'plugin manifest exposes the extension entrypoint').toBe('index.js');
  const paths = JSON.parse(readFileSync(join(ws.root, 'omp-setup-paths-record.jsonl'), 'utf8')) as { agentDir: string; pluginsDir: string };
  expect(paths.agentDir, 'default agent directory is discovered').toBe(join(ws.home, '.omp/agent'));
  expect(paths.pluginsDir, 'default plugin directory is discovered independently').toBe(join(ws.home, '.omp/plugins'));
  expect(readFileSync(join(ws.root, 'omp-probe-commands.txt'), 'utf8'), 'probe loads only the explicit extension without starting a model session').toContain('models --no-extensions -e ');
  const pluginLink = ompPluginLinkPath(ws);
  expect(lstatSync(pluginLink).isSymbolicLink()).toBeTruthy();
  expect(realpathSync(pluginLink), 'native plugin link targets the installed package').toBe(realpathSync(join(ompPluginsDirFor(ws), 'floway')));
  expect(readFileSync(join(ws.root, 'omp-plugin-commands.txt'), 'utf8').trim(), 'installer registers the source through omp plugin link').toBe(`plugin link ${join(ompPluginsDirFor(ws), 'floway')}`);
  const lockPath = ompPluginLockPath(ws);
  const pluginLock = readOmpPluginLock(ws);
  const registration = pluginLock.plugins?.[OMP_PLUGIN_NAME] as { version?: string; enabledFeatures?: unknown; enabled?: boolean } | undefined;
  expect(registration !== undefined).toBeTruthy();
  expect(registration?.version, 'native plugin registration uses the package version').toBe('1.0.0');
  expect(registration?.enabledFeatures, 'native plugin registration keeps default feature selection').toBe(null);
  expect(registration?.enabled, 'native plugin registration enables Floway').toBe(true);
  expect(statSync(lockPath).mode & 0o777, 'plugin settings and credentials are private').toBe(0o600);
  expect(readOmpConnections(ws)[0]?.endpoint, 'connection settings live in the native plugin lock').toBe(modelServer.url);
  expect(readOmpConnections(ws)[0]?.apiKey, 'connection credentials live in the native plugin lock').toBe(SENTINEL_KEY);
  expect(!existsSync(ompConfigPath(ws))).toBeTruthy();
  expect(!existsSync(ompModelsPath(ws))).toBeTruthy();
});

test('PowerShell: model set, changed, and cleared updates config.yml', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const configFile = ompConfigPath(ws);

  const run1 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'gpt-4o' }) });
  expect(run1.code, `setting model should succeed:\n${run1.combined}`).toBe(0);
  expect(existsSync(configFile)).toBeTruthy();
  const expectedConfig1 = [
    'modelRoles:',
    '  default: "floway/gpt-4o"',
    '',
  ].join('\n');
  expect(readFileSync(configFile, 'utf8'), 'exact config shape when set').toBe(expectedConfig1);

  const run2 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: "claude-3-5:special'quote" }) });
  expect(run2.code, `changing model should succeed:\n${run2.combined}`).toBe(0);
  const expectedConfig2 = [
    'modelRoles:',
    '  default: "floway/claude-3-5:special\'quote"',
    '',
  ].join('\n');
  expect(readFileSync(configFile, 'utf8'), 'exact config shape when changed with escaping').toBe(expectedConfig2);

  const run3 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: null }) });
  expect(run3.code, `clearing model should succeed:\n${run3.combined}`).toBe(0);
  expect(!existsSync(configFile) || readFileSync(configFile, 'utf8') === '').toBeTruthy();
});

test('PowerShell: idempotent re-run produces no diff and prunes backups', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run1 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'gpt-4o' }) });
  expect(run1.code, `first run should succeed:\n${run1.combined}`).toBe(0);
  const extension1 = readFileSync(ompExtensionPath(ws), 'utf8');
  const config1 = readFileSync(ompConfigPath(ws), 'utf8');

  const run2 = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'gpt-4o' }) });
  expect(run2.code, `second run should succeed:\n${run2.combined}`).toBe(0);
  expect(readFileSync(ompExtensionPath(ws), 'utf8'), 'extension source identical').toBe(extension1);
  expect(readFileSync(ompConfigPath(ws), 'utf8'), 'config.yml identical').toBe(config1);
  expect(ompBackupFiles(dirname(ompExtensionPath(ws)), 'index.js').length, 'no extension backups remain').toBe(0);
  expect(ompBackupFiles(dirname(ompPackagePath(ws)), 'package.json').length, 'no manifest backups remain').toBe(0);
  expect(ompBackupFiles(ompPluginsDirFor(ws), 'omp-plugins.lock.json').length, 'no plugin settings backups remain').toBe(0);
  expect(ompBackupFiles(ompDirFor(ws), 'config.yml').length, 'no config backups remain').toBe(0);
});

test('PowerShell: preserves unrelated providers, comments, roles, CRLF, and missing trailing newline', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });

  const priorModels = '# User comments\r\nproviders:\r\n  anthropic:\r\n    baseUrl: https://api.anthropic.com\r\n    apiKey: ant-secret';
  const priorConfig = '# Custom config\r\nmodelRoles:\r\n  plan: anthropic/claude-3-opus';
  writeFileSync(ompModelsPath(ws), priorModels);
  writeFileSync(ompConfigPath(ws), priorConfig);

  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'test-model' }) });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);

  const modelsText = readFileSync(ompModelsPath(ws), 'utf8');
  expect(modelsText, 'comments preserved in models.yml').toContain('# User comments');
  expect(modelsText, 'unrelated provider preserved').toContain('anthropic:');
  expect(modelsText, 'unrelated provider keys preserved').toContain('apiKey: ant-secret');
  expect(modelsText, 'no provider configuration is inserted').not.toContain('floway:');
  expect(modelsText.includes('\r\n')).toBeTruthy();

  const configText = readFileSync(ompConfigPath(ws), 'utf8');
  expect(configText, 'comments preserved in config.yml').toContain('# Custom config');
  expect(configText, 'unrelated role preserved').toContain('plan: anthropic/claude-3-opus');
  expect(configText, 'managed default inserted').toContain('default: "floway/test-model"');
  expect(configText.includes('\r\n')).toBeTruthy();

  const runClear = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: null }) });
  expect(runClear.code, `clearing should succeed:\n${runClear.combined}`).toBe(0);

  const configCleared = readFileSync(ompConfigPath(ws), 'utf8');
  expect(configCleared, 'comments preserved after clear').toContain('# Custom config');
  expect(configCleared, 'modelRoles header preserved').toContain('modelRoles:');
  expect(configCleared, 'unrelated user role preserved').toContain('plan: anthropic/claude-3-opus');
  expect(configCleared, 'managed default key removed').not.toContain('default:');
});

test('PowerShell: refuses config.yml containing tabs without modifying file', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const badContent = 'modelRoles:\n\tdefault: foo\n';
  writeFileSync(ompConfigPath(ws), badContent);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'foo' }) });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'error mentions tabs').toContain('tabs found in');
  expect(readFileSync(ompConfigPath(ws), 'utf8'), 'file unmodified').toBe(badContent);
});

test('PowerShell: refuses flow-style modelRoles mapping in config.yml without modifying file', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const badContent = 'modelRoles: {}\n';
  writeFileSync(ompConfigPath(ws), badContent);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'foo' }) });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'unsafe mapping is reported').toContain('modelRoles must be a single block-style YAML mapping');
  expect(readFileSync(ompConfigPath(ws), 'utf8'), 'file unmodified').toBe(badContent);
});

test('PowerShell: refuses an unmanaged extension without modifying it', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(dirname(ompExtensionPath(ws)), { recursive: true });
  const badContent = 'providers:\n  floway:\n    baseUrl: https://custom.example.com\n';
  writeFileSync(ompExtensionPath(ws), badContent);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'error mentions unmanaged floway provider').toContain('existing unmanaged Floway extension found');
  expect(readFileSync(ompExtensionPath(ws), 'utf8'), 'file unmodified').toBe(badContent);
});

test('PowerShell: refuses YAML anchors, aliases, or merge keys touching modelRoles in config.yml', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const badContent = 'modelRoles: &r\n  plan: claude\n';
  writeFileSync(ompConfigPath(ws), badContent);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'foo' }) });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'unsafe mapping is reported').toContain('without aliases');
  expect(readFileSync(ompConfigPath(ws), 'utf8'), 'file unmodified').toBe(badContent);
});

test('PowerShell: an explicit default replaces the previous provider while preserving other roles', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  mkdirSync(ompDirFor(ws), { recursive: true });
  const before = '# Preferences\r\nmodelRoles: # startup\r\n    default: openai/gpt-4o # default choice\r\n    plan: anthropic/claude\r\ntheme: dark';
  writeFileSync(ompConfigPath(ws), before);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig({ model: 'my-model' }) });
  expect(run.code, run.combined).toBe(0);
  expect(readFileSync(ompConfigPath(ws), 'utf8')).toBe(before.replace('openai/gpt-4o', '"floway/my-model"'));
});

test('PowerShell: rollback restores the prior plugin registration and settings after link failure', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const priorContent = SETUP_NODE_OMP_EXTENSION;
  const priorLock: OmpPluginLock = {
    plugins: { [OMP_PLUGIN_NAME]: { version: '1.0.0', enabledFeatures: null, enabled: false }, '@example/theme': { version: '2.0.0' } },
    settings: { [OMP_PLUGIN_NAME]: { theme: 'dark', connections: [{ provider: 'floway', endpoint: 'https://before.example', apiKey: 'old-key' }] }, '@example/theme': { enabled: true, color: 'violet' } },
  };
  seedOmpPlugin(ws, priorLock, priorContent);
  const priorLockText = readFileSync(ompPluginLockPath(ws), 'utf8');
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), fakeOmpLinkFailure: 'unlink' });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'failure occurs after native registration updates and link removal').toContain('fake omp plugin link removed the native link and injected a failure');
  expect(run.combined, 'plugin link failure enters rollback').toContain('oh-my-pi applying changes failed; rolling back configuration.');
  expect(existsSync(join(ws.root, 'omp-plugin-commands.txt'))).toBeTruthy();
  expect(readFileSync(ompExtensionPath(ws), 'utf8'), 'extension restored to original content').toBe(priorContent);
  expect(readFileSync(ompPluginLockPath(ws), 'utf8'), 'native registration and plugin settings are restored byte for byte').toBe(priorLockText);
  expect(realpathSync(ompPluginLinkPath(ws)), 'native link is restored to the Floway package').toBe(realpathSync(join(ompPluginsDirFor(ws), 'floway')));
  expect(ompStagedFiles(ompPluginsDirFor(ws)).length, 'no plugin stage files left behind').toBe(0);
});

test('PowerShell: rollback restore failure preserves backup file and warns operator', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const priorContent = SETUP_NODE_OMP_EXTENSION;
  seedOmpPlugin(ws, { plugins: { [OMP_PLUGIN_NAME]: { version: '1.0.0', enabledFeatures: null, enabled: false } }, settings: { [OMP_PLUGIN_NAME]: { connections: [] } } }, priorContent);
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpFailConfig: true,
    failRestore: true,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'fault reached after successful extension staging').toContain('oh-my-pi simulated failure; rolling back configuration.');
  expect(run.combined, 'rollback warning names restore failure').toContain('could not restore');
  expect(run.combined, 'operator guidance emitted').toContain('restore it by hand');
  const preservedBackups = ompBackupFiles(dirname(ompExtensionPath(ws)), 'index.js').length + ompBackupFiles(dirname(ompPackagePath(ws)), 'package.json').length;
  expect(preservedBackups > 0).toBeTruthy();
});

test('PowerShell: resolves agent directory from the native probe', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const customDir = join(ws.home, 'from-native-probe');
  const customPluginsDir = join(ws.home, 'independent-plugin-root');
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpAgentDir: customDir,
    fakeOmpPluginsDir: customPluginsDir,
  });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);
  const paths = JSON.parse(readFileSync(join(ws.root, 'omp-setup-paths-record.jsonl'), 'utf8')) as { agentDir: string; pluginsDir: string };
  expect(paths.agentDir, 'native probe preserves the native agent directory').toBe(customDir);
  expect(paths.pluginsDir, 'native probe can resolve an independent plugin root').toBe(customPluginsDir);
  expect(existsSync(ompExtensionPath(ws, 'independent-plugin-root'))).toBeTruthy();
});

test('PowerShell: propagates native probe failure without guessing the agent directory', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const customDir = join(ws.home, 'from-pi-env-dir');
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpProbeFailure: true,
    piCodingAgentDir: customDir,
  });
  expect(run.code).not.toBe(0);
  expect(run.combined).toContain('test native path probe failure');
  expect(!existsSync(customDir)).toBeTruthy();
  expect(!existsSync(join(ws.root, 'omp-setup-paths-record.jsonl'))).toBeTruthy();
});

test('PowerShell: resolves agent directory from OMP_PROFILE and ignores PI_CODING_AGENT_DIR', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const ignoredDir = join(ws.home, 'ignored-pi-env-dir');
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpAgentDir: join(ws.home, '.omp/profiles/work/agent'),
    fakeOmpPluginsDir: join(ws.home, '.omp/profiles/work/plugins'),
    ompProfile: 'work',
    piCodingAgentDir: ignoredDir,
  });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);
  const paths = JSON.parse(readFileSync(join(ws.root, 'omp-setup-paths-record.jsonl'), 'utf8')) as { agentDir: string; pluginsDir: string };
  expect(paths.agentDir, 'profile agent directory is discovered').toBe(join(ws.home, '.omp/profiles/work/agent'));
  expect(paths.pluginsDir, 'profile plugin directory is discovered').toBe(join(ws.home, '.omp/profiles/work/plugins'));
  expect(existsSync(ompExtensionPath(ws, '.omp/profiles/work/plugins'))).toBeTruthy();
  expect(!existsSync(ignoredDir)).toBeTruthy();
});

test('PowerShell: API key is never printed to stdout or stderr during setup', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'the API key must never be printed to stdout or stderr').not.toContain(SENTINEL_KEY);
});

test('PowerShell: ambient SETUP_API_KEY is not inherited by fake omp CLI', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), ambientApiKey: true });
  expect(run.code, `ambient key run should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'subprocesses must not inherit SETUP_API_KEY').not.toContain('fake omp inherited the setup API key');
});

test('PowerShell: CLI not found runs test installer hook and installs omp', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), withOmpInstallHook: true });
  expect(run.code, `hook installation should succeed:\n${run.combined}`).toBe(0);
  expect(existsSync(join(ws.home, '.local/bin/omp'))).toBeTruthy();
  expect(run.stdout, 'reports test installer invocation').toContain('oh-my-pi CLI not found; running the test installer');
  expect(existsSync(ompExtensionPath(ws))).toBeTruthy();
});

test('PowerShell prefers npm over the direct installer when npm is available', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig(), withOmpInstallHook: false });
  expect(run.code, `npm installation should succeed:\n${run.combined}`).toBe(0);
  expect(run.stdout, 'reports npm installation').toContain('oh-my-pi CLI not found; installing with npm');
  expect(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'npm receives the official global package').toBe('install --global @oh-my-pi/pi-coding-agent');
});

test('PowerShell: CLI not found fails when installer download fails', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    withOmpInstallHook: false,
    ompInstallerUrl: `${modelServer.url}/nonexistent`,
  });
  expect(run.code !== 0).toBeTruthy();
});

test('PowerShell: warns when multiple omp installations are detected', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const localBin = join(ws.home, '.local/bin');
  mkdirSync(localBin, { recursive: true });
  writeFileSync(join(localBin, 'omp'), FAKE_OMP, { mode: 0o755 });
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'warns about multiple CLIs').toContain('multiple oh-my-pi installations detected');
});

test('PowerShell: fails when omp --version times out', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runPowerShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    fakeOmpVersionSleep: 5,
    timeoutSeconds: 1,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'reports version command timeout').toContain('`omp --version` timed out');
});

test('local PowerShell installer accepts script content and rejects HTML', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const accepted = makeWorkspace();
  modelServer.mode = 'installer-omp-ps1';
  const success = await runPowerShellInstaller({
    workspace: accepted,
    configuration: ompConfig(),
    baseUrl: modelServer.url,
    withOmpInstallHook: false,
    ompInstallerUrl: `${modelServer.url}/install-omp.ps1`,
  });
  expect(success.code, `a local PowerShell installer should be accepted:\n${success.combined}`).toBe(0);
  expect(existsSync(installerMarker(accepted))).toBeTruthy();

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runPowerShellInstaller({
    workspace: rejected,
    configuration: ompConfig(),
    baseUrl: modelServer.url,
    withOmpInstallHook: false,
    ompInstallerUrl: `${modelServer.url}/install-omp.ps1`,
  });
  expect(failure.code !== 0).toBeTruthy();
  expect(!existsSync(installerMarker(rejected))).toBeTruthy();
});

test('PowerShell: timed-out installer terminates cleanly', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-omp-ps1';
  const started = Date.now();
  const run = await runPowerShellInstaller({
    workspace: ws,
    configuration: ompConfig(),
    baseUrl: modelServer.url,
    withOmpInstallHook: false,
    ompInstallerUrl: `${modelServer.url}/install-omp.ps1`,
    installerSleep: 12,
    timeoutSeconds: 1,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(Date.now() - started < 8_000).toBeTruthy();
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
});

test('PowerShell installer body parses without syntax errors', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const body = powerShellBody('omp');
  const entry = powerShellEntry('omp');
  expect(body.trimEnd().endsWith(entry)).toBeTruthy();
  expect(body.lastIndexOf(entry) > body.indexOf('function Set-SetupAgent {')).toBeTruthy();
  const script = renderPowerShellPrefix({
    agent: 'omp',
    extensionPath: '/omp.js',
    apiKey: SENTINEL_KEY,
    apiKeyName: 'Primary key',
    configuration: ompConfig({ model: 'm' }),
  }) + body;
  const scriptPath = join(HARNESS_ROOT, 'omp-parse-check.ps1');
  writeFileSync(scriptPath, script);
  const check = `$errs=$null; [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}',[ref]$null,[ref]$errs); if($errs -and $errs.Count -gt 0){ $errs | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 } else { exit 0 }`;
  const result = spawnSync(hostPwsh, ['-NoProfile', '-Command', check], { encoding: 'utf8' });
  expect(result.status, `PowerShell parse errors:\n${result.stdout}${result.stderr}`).toBe(0);
});

test('PowerShell: a download that ends before the final Main call performs no setup work', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const configuration = ompConfig();
  const body = powerShellBody('omp');
  const bodyWithoutEntry = body.slice(0, body.lastIndexOf(powerShellEntry('omp')));
  const script = renderPowerShellPrefix({ extensionPath: '/omp.js', agent: 'omp', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration }) + bodyWithoutEntry;
  const scriptPath = join(ws.root, 'truncated-omp-setup.ps1');
  writeFileSync(scriptPath, script);
  const result = spawnSync(hostPwsh, ['-NoProfile', '-File', scriptPath], {
    encoding: 'utf8',
    env: { HOME: ws.home, PATH: [ws.binDir, SHIM_BIN].join(':'), SETUP_ENDPOINT: modelServer.url },
  });
  expect(result.status, `definitions-only script should exit cleanly:\n${result.stderr}`).toBe(0);
  expect(result.stdout, 'definitions-only script prints nothing').toBe('');
  expect(!existsSync(ompExtensionPath(ws))).toBeTruthy();
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
});

test('PowerShell stages secret data only after protection and hardens Windows replacement targets', { timeout: 180_000 }, () => {
  const body = powerShellBody('omp');
  const stageFunctionIndex = body.indexOf('function Stage-SetupOmpPluginSettings');
  const createIndex = body.indexOf('[System.IO.File]::Create($script:OmpPluginSettingsStage).Dispose()', stageFunctionIndex);
  const protectStageIndex = body.indexOf('Protect-SetupFile $script:OmpPluginSettingsStage', createIndex);
  const writeIndex = body.indexOf('[System.IO.File]::WriteAllText($script:OmpPluginSettingsStage, (ConvertTo-Json', protectStageIndex);
  const applyIndex = body.indexOf('function Apply-SetupOmpFile');
  const protectTargetIndex = body.indexOf('Protect-SetupFile $Path', applyIndex);
  const replaceIndex = body.indexOf('[System.IO.File]::Replace($StagePath, $Path, [System.Management.Automation.Language.NullString]::Value)', protectTargetIndex);
  const applySettingsIndex = body.indexOf('Apply-SetupOmpFile -StagePath $script:OmpPluginSettingsStage -Path $script:OmpPluginSettingsPath', body.indexOf('function Apply-SetupOmpStaged'));
  expect(createIndex >= 0 && createIndex < protectStageIndex).toBeTruthy();
  expect(protectStageIndex < writeIndex).toBeTruthy();
  expect(protectTargetIndex < replaceIndex).toBeTruthy();
  expect(applySettingsIndex > writeIndex).toBeTruthy();
  expect(body, 'the replacement path uses the shared Windows predicate').toContain('$runningOnWindows = Test-SetupIsWindows');
  expect(body, 'backup timestamp must support the .NET Framework used by PowerShell 5.1').toContain("[long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds");
  expect(body, 'PowerShell 5.1-incompatible timestamp API must not be used').not.toContain('ToUnixTimeMilliseconds()');
  expect(body, 'new target must use a same-directory move').toContain('Move-Item -LiteralPath $StagePath -Destination $Path -Force');
});

test('installer scripts embed expected URLs and command sequences', { timeout: 180_000 }, () => {
  expect(SETUP_POWERSHELL_OMP, 'PowerShell can install omp with npm').toContain("Install-SetupNpmPackage -Package '@oh-my-pi/pi-coding-agent'");
  expect(SETUP_POWERSHELL_OMP, 'omp Windows uses the official install.ps1').toContain('https://omp.sh/install.ps1');
  expect(SETUP_BASH_OMP, 'Bash installer specifies the npm package name').toContain('@oh-my-pi/pi-coding-agent');
});

test('both installers reject empty downloads and unmanaged empty extensions', { timeout: 180_000 }, async () => {
  for (const runInstaller of [runShellInstaller, ...(hostPwsh ? [runPowerShellInstaller] : [])]) {
    const ws = makeWorkspace();
    placeFakeOmp(ws.binDir);
    modelServer.mode = 'empty-extension';
    const emptyDownload = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
    expect(emptyDownload.code !== 0).toBeTruthy();
    expect(!existsSync(ompExtensionPath(ws))).toBeTruthy();
    modelServer.reset();
    mkdirSync(dirname(ompExtensionPath(ws)), { recursive: true });
    writeFileSync(ompExtensionPath(ws), '');
    const emptyExisting = await runInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
    expect(emptyExisting.code !== 0).toBeTruthy();
    expect(readFileSync(ompExtensionPath(ws), 'utf8'), 'unmanaged empty file remains untouched').toBe('');
  }
});

test('real omp smoke: discovery succeeds and server receives headers', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostOmpBin) return skip(true, 'real omp is not available or --version failed');
  const ws = makeWorkspace();
  const ompHome = ws.home;
  const cmd = hostOmpBin;
  const version = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  expect(version.status, 'native CLI reports its version').toBe(0);
  const userAgent = version.stdout.trim();
  writeFileSync(join(ws.binDir, 'omp'), `#!/bin/sh\nexec ${shellLiteral(cmd)} "$@"\n`, { mode: 0o755 });
  const run = await runShellInstaller({
    workspace: ws,
    baseUrl: modelServer.url,
    configuration: ompConfig(),
    withOmpInstallHook: false,
  });
  expect(run.code, `omp installer should succeed: ${run.combined}`).toBe(0);
  // Asynchronous on purpose: the fixture server lives in this process, so a
  // blocking spawnSync would starve it and omp's discovery request would hang.
  const refresh = await new Promise<RunResult>(resolve => {
    const child = spawn(cmd, ['models', 'refresh'], { env: { ...process.env, HOME: ompHome } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, combined: `${stdout}${stderr}${String(error)}` }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: `${stdout}${stderr}` }));
  });
  expect(refresh.code, `models refresh failed: ${refresh.stderr}\n${refresh.stdout}`).toBe(0);
  const req = modelServer.requests.find(r => r.path === '/v1/models' || r.path === '/models');
  expect(req !== undefined).toBeTruthy();
  expect(req?.headers['authorization'], 'discovery sent Authorization header with setup API key').toBe(`Bearer ${SENTINEL_KEY}`);
  expect(req?.headers['user-agent'], 'discovery sends the installed CLI User-Agent').toBe(userAgent);

  const inference = await new Promise<RunResult>(resolve => {
    const child = spawn(cmd, ['--model', 'floway/floway-model-1', '--thinking', 'high', '--no-tools', '--no-lsp', '--no-session', '-p', 'hello'], { env: { ...process.env, HOME: ompHome } });
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', () => clearTimeout(timer));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: stdout + stderr }));
  });
  expect(inference.code, `inference failed: ${inference.combined}`).toBe(0);
  expect(inference.stdout, 'native streaming reaches the caller').toContain('Floway response');
  const inferenceRequest = modelServer.requests.find(request => request.path === '/v1/messages');
  expect(inferenceRequest !== undefined).toBeTruthy();
  expect((inferenceRequest!.body!.thinking as { budget_tokens: number }).budget_tokens, 'server budget bounds reach the native wire').toBe(1100);

  modelServer.reset();
  modelServer.mode = 'adaptive';
  const adaptive = await new Promise<RunResult>(resolve => {
    const child = spawn(cmd, ['--model', 'floway/floway-model-1', '--thinking', 'high', '--no-tools', '--no-lsp', '--no-session', '-p', 'hello'], { env: { ...process.env, HOME: ompHome } });
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', () => clearTimeout(timer));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: stdout + stderr }));
  });
  expect(adaptive.code, `adaptive inference failed: ${adaptive.combined}`).toBe(0);
  const adaptiveRequest = modelServer.requests.find(request => request.path === '/v1/messages')!;
  expect((adaptiveRequest.body!.thinking as { type: string }).type, 'model-controlled reasoning stays adaptive').toBe('adaptive');
  expect((adaptiveRequest.body!.output_config as { effort?: unknown } | undefined)?.effort, 'adaptive-only metadata emits no invented effort').toBe(undefined);

  if (hostPwsh) {
    const psWs = makeWorkspace();
    const psOmpHome = psWs.home;
    writeFileSync(join(psWs.binDir, 'omp'), `#!/bin/sh\nexec ${shellLiteral(cmd)} "$@"\n`, { mode: 0o755 });
    modelServer.reset();
    const psRun = await runPowerShellInstaller({
      workspace: psWs,
      baseUrl: modelServer.url,
      configuration: ompConfig(),
      withOmpInstallHook: false,
    });
    expect(psRun.code, `omp PowerShell installer should succeed: ${psRun.combined}`).toBe(0);
    const psRefresh = await new Promise<RunResult>(resolve => {
      const child = spawn(cmd, ['models', 'refresh'], { env: { ...process.env, HOME: psOmpHome } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, combined: `${stdout}${stderr}${String(error)}` }));
      child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: `${stdout}${stderr}` }));
    });
    expect(psRefresh.code, `models refresh failed: ${psRefresh.stderr}\n${psRefresh.stdout}`).toBe(0);
    const psReq = modelServer.requests.find(r => r.path === '/v1/models' || r.path === '/models');
    expect(psReq !== undefined).toBeTruthy();
    expect(psReq?.headers['authorization'], 'discovery sent Authorization header with setup API key').toBe(`Bearer ${SENTINEL_KEY}`);
    expect(psReq?.headers['user-agent'], 'discovery sends the installed CLI User-Agent').toBe(userAgent);
  }
});
