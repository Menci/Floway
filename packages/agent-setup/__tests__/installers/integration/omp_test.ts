import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, test } from 'vitest';

import { OMP_PLUGIN_NAME, SENTINEL_KEY, hostOmpBin, hostPwsh, makeWorkspace, modelServer, ompBackupFiles, ompConfig, ompConfigPath, ompDirFor, ompExtensionPath, ompModelsPath, ompPackagePath, ompPluginLinkPath, ompPluginLockPath, ompPluginsDirFor, ompStagedFiles, placeFakeOmp, readOmpConnections, readOmpPluginLock, runPowerShellInstaller, runShellInstaller, seedOmpPlugin, shellLiteral } from './harness';
import type { OMP_PLUGIN_MANIFEST, OmpPluginLock, RunResult } from './harness';
import { SETUP_NODE_OMP_EXTENSION } from '../../../src/script-assets.generated.ts';

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

test('API key is never printed to stdout or stderr during setup', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeOmp(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: ompConfig() });
  expect(run.code, `setup should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'the API key must never be printed to stdout or stderr').not.toContain(SENTINEL_KEY);
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
