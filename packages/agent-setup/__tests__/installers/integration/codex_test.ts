import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test } from 'vitest';

import { SENTINEL_KEY, bothConfig, codexAuthPath, codexBackupFiles, codexConfig, codexConfigPath, codexEditMap, codexHomeFor, codexTokenPath, hostPwsh, installerMarker, makeWorkspace, modelServer, placeFakeClaude, placeFakeCodex, placeFakeNpm, readCodexRecord, readCodexToken, resolveTool, runPowerShellInstaller, runShellInstaller, settingsPathFor, stagedFiles } from './harness';
import type { Workspace } from './harness';
import { SETUP_POWERSHELL_CODEX, SETUP_POWERSHELL_COMMON } from '../../../src/script-assets.generated.ts';

// Every fixed leaf the installer must batch-write, independent of model/effort.
const assertCodexBaseEdits = (ws: Workspace, baseUrl: string): void => {
  const edits = codexEditMap(ws);
  const codexBase = `${baseUrl.replace(/\/$/, '')}/azure-api.codex`;
  expect(edits.get('model_provider'), 'model_provider set to floway').toBe('floway');
  expect(edits.get('suppress_unstable_features_warning'), 'under-development feature warning suppressed').toBe(true);
  expect(edits.get('model_providers.floway.name'), 'provider name is Floway').toBe('Floway');
  expect(edits.get('model_providers.floway.base_url'), 'provider base_url targets the Codex data-plane path').toBe(codexBase);
  const auth = edits.get('model_providers.floway.auth') as { command?: unknown; args?: unknown };
  expect(auth.command, 'provider auth uses the host shell on Unix').toBe('sh');
  expect(JSON.stringify(auth.args), 'provider auth reads the token under the active CODEX_HOME').toBe(JSON.stringify(['-c', 'cat "${CODEX_HOME:-$HOME/.codex}/floway-token"']));
  expect(edits.get('model_providers.floway.wire_api'), 'provider wire_api is responses').toBe('responses');
  expect(edits.get('model_providers.floway.supports_websockets'), 'provider advertises websocket support').toBe(true);
  expect(JSON.stringify(edits.get('model_providers.floway.http_headers')), 'provider carries the actor-authorization marker').toBe(JSON.stringify({ 'x-openai-actor-authorization': '1' }));
  expect(edits.get('features.apps'), 'features.apps disabled').toBe(false);
  expect(edits.get('features.standalone_web_search'), 'client-owned web search enabled').toBe(true);
  expect(edits.has('model')).toBeTruthy();
  expect(edits.has('model_reasoning_effort')).toBeTruthy();
  expect(edits.size, 'the batch contains only the provider, feature-warning, feature, model, and effort leaves managed by Floway').toBe(12);
};

const assertStagedToken = (ws: Workspace, codexHome?: string): void => {
  expect(readCodexToken(ws, codexHome), 'provider token carries the setup API key byte-for-byte').toBe(SENTINEL_KEY);
};

const realCodex = process.env.CODEX_TEST_BIN ?? resolveTool('codex');

// The two absolute locations `codex_discover` consults beyond $HOME and PATH.
// The install-from-absent tests require discovery to find nothing, so they
// self-skip on a host that already has a system Codex there — the same
// host-condition guarding as the pwsh and network tests.
const GLOBAL_CODEX_LOCATIONS = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
const globalCodexPresent = (): boolean => GLOBAL_CODEX_LOCATIONS.some(p => existsSync(p));

test('existing CLI configures via the app-server and stages the provider token', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  expect(run.code, `codex setup should succeed:\n${run.combined}`).toBe(0);
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
  expect(run.stdout, 'the header names Codex').toContain('==> Agent Setup: Codex\nEndpoint:');
  expect(run.stdout, 'installation reports the existing CLI and its version').toContain('==> Installing: Codex\nCodex is already installed.\nCodex version:');
  expect(run.stdout, 'configuration has its own section').toContain('==> Configuring: Codex\n');
  expect(run.stdout, 'the app-server config path is reported').toContain(`Written to \`${codexConfigPath(ws)}\`.`);
  expect(run.stdout, 'the provider-token path is reported').toContain(`Written to \`${codexTokenPath(ws)}\`.`);
  expect(run.stdout, 'the final outcome is explicit').toContain('==> Completed Agent Setup: Codex');
  assertCodexBaseEdits(ws, modelServer.url);
  assertStagedToken(ws);
});

test('the batch clears model and effort when unset', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  const edits = codexEditMap(ws);
  expect(edits.get('model'), 'unset model clears via JSON null').toBe(null);
  expect(edits.get('model_reasoning_effort'), 'unset effort clears via JSON null').toBe(null);
});

test('the batch sets opaque model and effort verbatim', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url,
    configuration: codexConfig({ model: 'weird/model:v2', reasoningEffort: 'ultra' }),
  });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  const edits = codexEditMap(ws);
  expect(edits.get('model'), 'opaque model is written verbatim').toBe('weird/model:v2');
  expect(edits.get('model_reasoning_effort'), 'opaque effort is written verbatim').toBe('ultra');
});

test('the handshake runs initialize then initialized then config/batchWrite in order', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  const record = readCodexRecord(ws);
  const order = record.map(r => r.received?.method ?? r.marker).filter(Boolean);
  const initialize = order.indexOf('initialize');
  const initialized = order.indexOf('initialized');
  const batch = order.indexOf('config/batchWrite');
  expect(initialize >= 0 && initialized > initialize).toBeTruthy();
  expect(batch > initialized).toBeTruthy();
  const initReq = record.find(r => r.received?.method === 'initialize');
  expect(initReq !== undefined).toBeTruthy();
});

test('okOverridden counts as success and reports non-secret override metadata only', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'okOverridden' });
  expect(run.code, `okOverridden must be treated as configured:\n${run.combined}`).toBe(0);
  expect(run.combined, 'the override message is surfaced').toContain('Overridden by session flags');
  expect(run.combined.toLowerCase(), 'the overriding layer is surfaced').toContain('sessionflags');
  expect(run.combined, 'the overridden effective value is not echoed').not.toContain('shadow-model');
  expect(existsSync(codexTokenPath(ws))).toBeTruthy();
});

test('a batchWrite JSON-RPC error fails codex and rolls back the provider token', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const configDir = codexHomeFor(ws);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'error' });
  expect(run.code !== 0).toBeTruthy();
  expect(readCodexToken(ws), 'prior provider token is restored on rollback').toBe('old-provider-token');
});

test('a malformed app-server response fails codex', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'malformed' });
  expect(run.code !== 0).toBeTruthy();
  expect(!existsSync(codexTokenPath(ws))).toBeTruthy();
});

test('an app-server exit between handshake writes rolls back the provider token', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'close-request-after-initialize' });
  expect(run.code !== 0).toBeTruthy();
  expect(!existsSync(codexTokenPath(ws))).toBeTruthy();
});

test('a premature app-server exit before responding fails codex', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'premature-eof' });
  expect(run.code !== 0).toBeTruthy();
  expect(!existsSync(codexTokenPath(ws))).toBeTruthy();
});

test('a delayed batch response within the deadline succeeds because stdin stays open', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    fakeCodexAppServerMode: 'ok', fakeCodexBatchDelay: 2, timeoutSeconds: 30,
  });
  expect(run.code, `a response delayed under the deadline must still succeed:\n${run.combined}`).toBe(0);
  const record = readCodexRecord(ws);
  const respondIdx = record.findIndex(r => r.marker === 'batch-respond');
  const eofIdx = record.findIndex(r => r.marker === 'stdin-eof');
  expect(respondIdx >= 0).toBeTruthy();
  expect(eofIdx === -1 || respondIdx < eofIdx).toBeTruthy();
});

test('a batch response past the deadline times out, kills the tree, and rolls back', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const started = Date.now();
  const run = await runShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    fakeCodexAppServerMode: 'ok', fakeCodexBatchDelay: 8, timeoutSeconds: 1, excludeTimeoutTools: true,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(Date.now() - started < 5_000).toBeTruthy();
  expect(!existsSync(codexTokenPath(ws))).toBeTruthy();
});

test('a missing initialize response times out and fails', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const started = Date.now();
  const run = await runShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    fakeCodexAppServerMode: 'no-initialize-response', timeoutSeconds: 1, excludeTimeoutTools: true,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(Date.now() - started < 5_000).toBeTruthy();
});

test('a large app-server stderr stream does not deadlock the exchange', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexLargeStderr: true });
  expect(run.code, `a chatty stderr must not block the JSON-RPC exchange:\n${run.combined.slice(0, 2000)}`).toBe(0);
  assertCodexBaseEdits(ws, modelServer.url);
});

test('honors an explicit CODEX_HOME for config and provider token', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const codexHome = join(ws.root, 'custom-codex-home');
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, codexHome });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(existsSync(codexTokenPath(ws, codexHome))).toBeTruthy();
  expect(!existsSync(codexTokenPath(ws))).toBeTruthy();
  assertStagedToken(ws, codexHome);
});

test('missing CLI triggers the configured installer hook', { timeout: 180_000 }, async ({ skip }) => {
  if (globalCodexPresent()) return skip(true, 'a system Codex is installed at a known location; cannot simulate an absent CLI');
  const ws = makeWorkspace();
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  expect(run.code, `codex setup should succeed after install:\n${run.combined}`).toBe(0);
  expect(existsSync(installerMarker(ws))).toBeTruthy();
  expect(existsSync(join(ws.home, '.local/bin/codex'))).toBeTruthy();
  assertCodexBaseEdits(ws, modelServer.url);
});

test('npm is preferred over the direct installer when npm is available', { timeout: 180_000 }, async ({ skip }) => {
  if (globalCodexPresent()) return skip(true, 'a system Codex is installed at a known location; cannot simulate an absent CLI');
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, withCodexInstallHook: false });
  expect(run.code, `npm installation should succeed:\n${run.combined}`).toBe(0);
  expect(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'npm receives the official global package').toBe('install --global @openai/codex');
  expect(run.stdout, 'the selected installation source is reported plainly').toContain('Codex CLI not found; installing with npm');
});

test('the staged provider token is mode 0600', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  const mode = statSync(codexTokenPath(ws)).mode & 0o777;
  expect(mode, `floway-token should be 0600, got ${mode.toString(8)}`).toBe(0o600);
});

test('successful re-runs retain one config backup and no provider-token backup', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  const priorConfig = 'model_provider = "old"\nkeep_me = "yes"\n';
  const priorAuth = '{"tokens":{"access_token":"official-account-token"}}';
  writeFileSync(codexConfigPath(ws), priorConfig);
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  writeFileSync(codexAuthPath(ws), priorAuth);

  const first = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  expect(first.code, `first run should succeed:\n${first.combined}`).toBe(0);
  const second = await runShellInstaller({ workspace: ws, configuration: codexConfig({ reasoningEffort: 'high' }), baseUrl: modelServer.url });
  expect(second.code, `second run should succeed:\n${second.combined}`).toBe(0);

  expect(codexBackupFiles(home, 'config.toml').length, 'only the latest config.toml backup is retained').toBe(1);
  expect(codexBackupFiles(home, 'floway-token').length, 'provider-token backups are removed after each successful commit').toBe(0);
  expect(readFileSync(codexAuthPath(ws), 'utf8'), 'official account auth remains byte-for-byte unchanged').toBe(priorAuth);
  expect(readdirSync(home).filter(name => name.startsWith('auth.json.floway-backup.')).length, 'account auth is not backed up because it is not managed').toBe(0);
});

test('configuration failure restores prior config and provider token without touching auth.json', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  const priorConfig = 'model_provider = "old"\nkeep_me = "yes"\n';
  const priorToken = 'old-provider-token';
  const priorAuth = '{"tokens":{"access_token":"official-account-token"}}';
  writeFileSync(codexConfigPath(ws), priorConfig);
  writeFileSync(codexTokenPath(ws), priorToken);
  writeFileSync(codexAuthPath(ws), priorAuth);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'error' });
  expect(run.code !== 0).toBeTruthy();
  expect(readFileSync(codexConfigPath(ws), 'utf8'), 'config.toml restored to the original').toBe(priorConfig);
  expect(readCodexToken(ws), 'provider token restored to the original').toBe(priorToken);
  expect(readFileSync(codexAuthPath(ws), 'utf8'), 'auth.json remains byte-for-byte unchanged').toBe(priorAuth);
  expect(stagedFiles(home).length, 'no staged file is left behind').toBe(0);
});

test('provider-token staging failure leaves config and auth.json untouched', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  const priorConfig = 'model_provider = "old"\nkeep_me = "yes"\n';
  const priorAuth = '{"tokens":{"access_token":"official-account-token"}}';
  writeFileSync(codexConfigPath(ws), priorConfig);
  writeFileSync(codexAuthPath(ws), priorAuth);
  writeFileSync(join(ws.binDir, 'chmod'), '#!/bin/bash\nexit 73\n', { mode: 0o755 });
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  expect(run.code !== 0).toBeTruthy();
  expect(readFileSync(codexConfigPath(ws), 'utf8'), 'config remains unchanged because token staging precedes the app-server write').toBe(priorConfig);
  expect(readFileSync(codexAuthPath(ws), 'utf8'), 'auth.json remains unchanged').toBe(priorAuth);
  expect(stagedFiles(home).length, 'the failed token stage is removed').toBe(0);
});

test('a restore failure during rollback preserves the provider-token backup and warns instead of silently claiming success', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  writeFileSync(codexTokenPath(ws), 'old-provider-token');

  // Configuration fails (rollback is attempted) and the restore-from-backup mv
  // itself fails. The original provider token must not be reported as restored.
  const run = await runShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    fakeCodexAppServerMode: 'error', fakeRestoreFailure: true,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'a rollback-failure warning is printed').toContain('could not restore');
  expect(run.combined, 'the warning names the provider-token path').toContain(codexTokenPath(ws));
  const backups = codexBackupFiles(home, 'floway-token');
  expect(backups.length, 'the provider-token backup is preserved for manual recovery').toBe(1);
  expect(readCodexToken(ws), 'the managed token remains in place because restore failed').toBe(SENTINEL_KEY);
});

test('configuration failure with no prior files removes the created provider token', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'error' });
  expect(run.code !== 0).toBeTruthy();
  expect(!existsSync(codexTokenPath(ws))).toBeTruthy();
  expect(codexBackupFiles(codexHomeFor(ws), 'floway-token').length, 'no provider-token backup exists when none pre-existed').toBe(0);
});

test('raw codex --version output is displayed', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexVersion: 'codex-cli 0.144.1' });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'the raw version string is surfaced').toContain('codex-cli 0.144.1');
});

test('a codex --version timeout is bounded before configuration', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const started = Date.now();
  const run = await runShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    fakeCodexVersionSleep: 8, timeoutSeconds: 1, excludeTimeoutTools: true,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(Date.now() - started < 5_000).toBeTruthy();
  expect(!existsSync(codexTokenPath(ws))).toBeTruthy();
});

test('the API key never appears in output and never reaches the app-server', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url,
    configuration: codexConfig({ model: 'gpt-5-codex', reasoningEffort: 'high' }),
  });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'the API key must never be printed').not.toContain(SENTINEL_KEY);
  expect(run.combined, 'the app-server must never observe the key in a request').not.toContain('received the API key');
  // Sanity: the key really was written to the token file so the absence above is meaningful.
  expect(readCodexToken(ws), 'the key was actually staged into floway-token').toBe(SENTINEL_KEY);
});

test('setup performs no gateway request', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  modelServer.reset();
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(modelServer.requests.length, 'installation and configuration remain entirely local').toBe(0);
});

test('a Codex script never configures Claude when Codex fails', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  placeFakeCodex(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'codex',
    fakeCodexAppServerMode: 'error',
  });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'single-agent scripts do not print a redundant summary').not.toContain('Summary');
  expect(run.combined, 'the Codex script does not mention the unselected agent').not.toContain('Claude Code');
  expect(!existsSync(settingsPathFor(ws))).toBeTruthy();
});

test('the two agent-specific scripts configure independently against one configuration', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  placeFakeCodex(ws.binDir);
  const claude = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'claude' });
  expect(claude.code, `Claude should configure:\n${claude.combined}`).toBe(0);
  const codex = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'codex' });
  expect(codex.code, `Codex should configure:\n${codex.combined}`).toBe(0);
  assertCodexBaseEdits(ws, modelServer.url);
  expect(existsSync(settingsPathFor(ws))).toBeTruthy();
});

test('local Bash installer accepts shell content and rejects HTML for codex', { timeout: 180_000 }, async ({ skip }) => {
  if (globalCodexPresent()) return skip(true, 'a system Codex is installed at a known location; cannot simulate an absent CLI');
  const accepted = makeWorkspace();
  modelServer.mode = 'installer-codex-sh';
  const success = await runShellInstaller({
    workspace: accepted, configuration: codexConfig(), baseUrl: modelServer.url,
    withCodexInstallHook: false, codexInstallerUrl: `${modelServer.url}/install-codex.sh`,
  });
  expect(success.code, `a local codex shell installer should be accepted:\n${success.combined}`).toBe(0);
  expect(existsSync(installerMarker(accepted))).toBeTruthy();

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runShellInstaller({
    workspace: rejected, configuration: codexConfig(), baseUrl: modelServer.url,
    withCodexInstallHook: false, codexInstallerUrl: `${modelServer.url}/install-codex.sh`,
  });
  expect(failure.code !== 0).toBeTruthy();
  expect(!existsSync(installerMarker(rejected))).toBeTruthy();
});

test('multiple installations produce a warning and PATH wins', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  placeFakeCodex(join(ws.home, '.local/bin'));
  const run = await runShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined.toLowerCase(), 'a multiple-installation warning is printed').toContain('multiple');
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
});

// --- Codex PowerShell parse + execution -------------------------------------

test('PowerShell: existing CLI configures via the app-server and stages the provider token', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig({ model: 'gpt-5-codex', reasoningEffort: 'high' }), baseUrl: modelServer.url });
  expect(run.code, `codex setup should succeed:\n${run.combined}`).toBe(0);
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
  expect(run.stdout, 'the app-server config path is reported').toContain(`Written to \`${codexConfigPath(ws)}\`.`);
  expect(run.stdout, 'the provider-token path is reported').toContain(`Written to \`${codexTokenPath(ws)}\`.`);
  assertCodexBaseEdits(ws, modelServer.url);
  const edits = codexEditMap(ws);
  expect(edits.get('model'), 'model written verbatim').toBe('gpt-5-codex');
  expect(edits.get('model_reasoning_effort'), 'effort written verbatim').toBe('high');
  assertStagedToken(ws);
});

test('PowerShell: successful setup removes the provider-token backup', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  writeFileSync(codexConfigPath(ws), 'model_provider = "old"\n');
  writeFileSync(codexTokenPath(ws), 'old-provider-token');

  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  expect(run.code, `codex setup should succeed:\n${run.combined}`).toBe(0);
  expect(codexBackupFiles(home, 'config.toml').length, 'the latest config backup remains available').toBe(1);
  expect(codexBackupFiles(home, 'floway-token').length, 'the provider-token rollback copy is removed after commit').toBe(0);
});

test('PowerShell: provider token is UTF-8 without a BOM under a non-default culture', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    powerShellTimeSeparator: '.',
  });
  expect(run.code, `culture-independent provider-token staging should succeed:\n${run.combined}`).toBe(0);
  const token = readFileSync(codexTokenPath(ws));
  expect(token.toString('utf8'), 'provider token decodes to the exact API key').toBe(SENTINEL_KEY);
  expect(!(token[0] === 0xef && token[1] === 0xbb && token[2] === 0xbf)).toBeTruthy();
});

test('PowerShell: the batch clears model and effort when unset', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  const edits = codexEditMap(ws);
  expect(edits.get('model'), 'unset model clears via JSON null').toBe(null);
  expect(edits.get('model_reasoning_effort'), 'unset effort clears via JSON null').toBe(null);
});

test('PowerShell: okOverridden counts as success and reports non-secret metadata only', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'okOverridden' });
  expect(run.code, `okOverridden must be treated as configured:\n${run.combined}`).toBe(0);
  expect(run.combined, 'the override message is surfaced').toContain('Overridden by session flags');
  expect(run.combined, 'the overridden effective value is not echoed').not.toContain('shadow-model');
});

test('PowerShell: Windows provider-token replacement and rollback preserve owner-only ACL ordering', { timeout: 180_000 }, async () => {
  const tokenFnStart = SETUP_POWERSHELL_CODEX.indexOf('function Write-SetupCodexToken');
  const tokenFnEnd = SETUP_POWERSHELL_CODEX.indexOf('function Write-SetupCodexVersion', tokenFnStart);
  const tokenBody = SETUP_POWERSHELL_CODEX.slice(tokenFnStart, tokenFnEnd);
  const createStage = tokenBody.indexOf('[System.IO.File]::Create($stage).Dispose()');
  const protectStage = tokenBody.indexOf('Protect-SetupFile $stage', createStage);
  const writeSecret = tokenBody.indexOf('[System.IO.File]::WriteAllText($stage, $SetupApiKey', protectStage);
  const protectTarget = tokenBody.indexOf('Protect-SetupFile $script:CodexTokenPath', writeSecret);
  const replaceTarget = tokenBody.indexOf('[System.IO.File]::Replace($stage, $script:CodexTokenPath, [System.Management.Automation.Language.NullString]::Value)', protectTarget);
  expect(tokenFnStart >= 0).toBeTruthy();
  expect(tokenFnEnd >= 0).toBeTruthy();
  expect(createStage >= 0).toBeTruthy();
  expect(protectStage >= 0).toBeTruthy();
  expect(writeSecret >= 0).toBeTruthy();
  expect(protectTarget >= 0).toBeTruthy();
  expect(replaceTarget >= 0).toBeTruthy();
  expect(createStage < protectStage).toBeTruthy();
  expect(protectStage < writeSecret).toBeTruthy();
  expect(protectTarget < replaceTarget).toBeTruthy();

  const restoreHelperStart = SETUP_POWERSHELL_COMMON.indexOf('function Restore-SetupManagedFile');
  const restoreHelperEnd = SETUP_POWERSHELL_COMMON.indexOf('# --- run', restoreHelperStart);
  const restoreHelperBody = SETUP_POWERSHELL_COMMON.slice(restoreHelperStart, restoreHelperEnd);
  const restoreMove = restoreHelperBody.indexOf('Move-Item -LiteralPath $Backup -Destination $Path -Force');
  expect(restoreHelperStart >= 0).toBeTruthy();
  expect(restoreHelperEnd >= 0).toBeTruthy();
  expect(restoreMove >= 0).toBeTruthy();
  expect(restoreHelperBody, 'rollback keeps the already-protected backup inode instead of adding a fallible post-move step').not.toContain('Protect-SetupFile $Path');

  const restoreStart = SETUP_POWERSHELL_CODEX.indexOf('function Restore-SetupCodexFiles');
  const restoreEnd = SETUP_POWERSHELL_CODEX.indexOf('function Invoke-SetupCodexAppServerBatchWrite', restoreStart);
  expect(restoreStart >= 0).toBeTruthy();
  expect(restoreEnd >= 0).toBeTruthy();
});

test('PowerShell: existing provider token uses File.Replace with a real null backup path', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  const run = await runPowerShellInstaller({
    workspace: ws,
    configuration: codexConfig(),
    baseUrl: modelServer.url,
    forcePowerShellWindowsReplacement: true,
  });
  expect(run.code, `File.Replace should succeed:\n${run.combined}`).toBe(0);
  assertStagedToken(ws);
});

test('PowerShell: a batchWrite error fails codex and rolls back the provider token', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'error' });
  expect(run.code !== 0).toBeTruthy();
  expect(readCodexToken(ws), 'prior provider token is restored on rollback').toBe('old-provider-token');
});

test('PowerShell: a provider-token backup protection failure removes the unsafe backup and leaves the original intact', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  if (process.platform === 'win32') return skip(true, 'the chmod-based protection-failure injection is Unix-only');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  const priorToken = 'old-provider-token';
  const priorAuth = '{"tokens":{"access_token":"official-account-token"}}';
  writeFileSync(codexTokenPath(ws), priorToken);
  writeFileSync(codexAuthPath(ws), priorAuth);

  // chmod fails, so Protect-SetupFile throws while hardening the token backup —
  // the first protected copy in the Codex flow, before any mutation.
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeChmodFailure: true,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(codexBackupFiles(home, 'floway-token').length, 'the unprotected provider-token backup is removed').toBe(0);
  expect(readCodexToken(ws), 'the original provider token is unchanged').toBe(priorToken);
  expect(readFileSync(codexAuthPath(ws), 'utf8'), 'account auth remains unchanged').toBe(priorAuth);
  expect(run.combined, 'the API key must never be printed').not.toContain(SENTINEL_KEY);
});

test('PowerShell: a malformed response fails codex', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'malformed' });
  expect(run.code !== 0).toBeTruthy();
  expect(!existsSync(codexTokenPath(ws))).toBeTruthy();
});

test('PowerShell: a premature app-server exit fails codex', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, fakeCodexAppServerMode: 'premature-eof' });
  expect(run.code !== 0).toBeTruthy();
  expect(!existsSync(codexTokenPath(ws))).toBeTruthy();
});

test('PowerShell: a batch response past the deadline times out and rolls back', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const started = Date.now();
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    fakeCodexAppServerMode: 'ok', fakeCodexBatchDelay: 8, timeoutSeconds: 1,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(Date.now() - started < 6_000).toBeTruthy();
  expect(!existsSync(codexTokenPath(ws))).toBeTruthy();
});

test('PowerShell: honors an explicit CODEX_HOME', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const codexHome = join(ws.root, 'custom-codex-home');
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url, codexHome });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(existsSync(codexTokenPath(ws, codexHome))).toBeTruthy();
  expect(!existsSync(codexTokenPath(ws))).toBeTruthy();
});

test('PowerShell: the API key never appears in output and never reaches the app-server', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig({ model: 'gpt-5-codex' }), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'the API key must never be printed').not.toContain(SENTINEL_KEY);
  expect(run.combined, 'the app-server must never observe the key in a request').not.toContain('received the API key');
  expect(readCodexToken(ws), 'the key was actually staged into floway-token').toBe(SENTINEL_KEY);
});

test('PowerShell: missing CLI triggers the documented remote installer invocation', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-codex-ps1';
  try {
    const run = await runPowerShellInstaller({
      workspace: ws,
      configuration: codexConfig(),
      baseUrl: modelServer.url,
      withCodexInstallHook: false,
      codexInstallerUrl: `${modelServer.url}/install-codex.ps1`,
    });
    expect(run.code, `should succeed after install:\n${run.combined}`).toBe(0);
    expect(existsSync(installerMarker(ws))).toBeTruthy();
    const installerCommandLine = readFileSync(join(ws.root, 'installer-command-line.txt'), 'utf8');
    expect(installerCommandLine, 'the Codex installer subprocess matches the documented process-scoped execution-policy override').toContain('-ExecutionPolicy Bypass');
    assertCodexBaseEdits(ws, modelServer.url);
  } finally {
    modelServer.mode = 'ok';
  }
});

test('PowerShell: CODEX_NON_INTERACTIVE is scoped to installer invocation and removed afterward', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({ workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url });
  expect(run.code, `missing CLI should install without leaking CODEX_NON_INTERACTIVE to codex:\n${run.combined}`).toBe(0);
  expect(readFileSync(join(ws.root, 'installer-non-interactive.txt'), 'utf8'), 'the installer itself receives CODEX_NON_INTERACTIVE=true').toBe('true');
  expect(run.combined, 'app-server and version subprocesses see no new ambient value').not.toContain('unexpected CODEX_NON_INTERACTIVE');
});

test('PowerShell: a pre-existing CODEX_NON_INTERACTIVE value is restored after installation', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: codexConfig(), baseUrl: modelServer.url,
    ambientCodexNonInteractive: 'caller-value',
  });
  expect(run.code, `missing CLI should restore the caller's environment value:\n${run.combined}`).toBe(0);
  expect(readFileSync(join(ws.root, 'installer-non-interactive.txt'), 'utf8'), 'the installer receives the required temporary true value').toBe('true');
  expect(run.combined, 'app-server and version subprocesses see the restored caller value').not.toContain('unexpected CODEX_NON_INTERACTIVE');
});

test('PowerShell: a Codex script never configures Claude when Codex fails', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  placeFakeCodex(ws.binDir);
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'codex', fakeCodexAppServerMode: 'error' });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'single-agent scripts do not print a redundant summary').not.toContain('Summary');
  expect(run.combined, 'the Codex script does not mention the unselected agent').not.toContain('Claude Code');
  expect(!existsSync(settingsPathFor(ws))).toBeTruthy();
});

// --- Codex real-binary smoke test -------------------------------------------

for (const [label, runner] of [['Bash', runShellInstaller], ['PowerShell', runPowerShellInstaller]] as const) {
  test(`${label}: real Codex app-server writes config.toml`, { timeout: 180_000 }, async ({ skip }) => {
    if (!realCodex) return skip(true, 'real Codex is not installed on this host');
    if (label === 'PowerShell' && !hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
    const codexBinary = resolve(realCodex);
    const version = spawnSync(codexBinary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (version.error) throw version.error;
    expect(version.status, `real Codex --version should succeed:\n${version.stderr}`).toBe(0);
    expect(version.stdout.trim().length > 0).toBeTruthy();
    console.log(`  Codex compatibility (${label}): ${version.stdout.trim()}`);
    const ws = makeWorkspace();
    symlinkSync(codexBinary, join(ws.binDir, 'codex'));
    const codexHome = join(ws.root, 'real-codex-home');
    const run = await runner({
      workspace: ws, baseUrl: modelServer.url,
      configuration: codexConfig({ model: 'gpt-5-codex', reasoningEffort: 'high' }),
      codexHome, withCodexInstallHook: false,
    });
    expect(run.code, `real codex app-server configuration should succeed:\n${run.combined}`).toBe(0);
    const configText = readFileSync(codexConfigPath(ws, codexHome), 'utf8');
    const codexBase = `${modelServer.url.replace(/\/$/, '')}/azure-api.codex`;
    expect(configText, 'real config.toml carries the provider selection').toContain('model_provider = "floway"');
    expect(configText, 'real config.toml carries the wire_api').toContain('wire_api = "responses"');
    expect(configText, 'real config.toml carries websocket support').toContain('supports_websockets = true');
    expect(configText, 'real config.toml carries the actor-authorization marker').toContain('x-openai-actor-authorization');
    expect(configText, 'real config.toml enables client-owned web search').toContain('standalone_web_search = true');
    expect(configText, 'real config.toml suppresses the paired under-development warning').toContain('suppress_unstable_features_warning = true');
    expect(configText, 'real config.toml carries the provider base_url').toContain(`base_url = "${codexBase}"`);
    expect(configText, 'real config.toml carries the selected model').toContain('model = "gpt-5-codex"');
    expect(configText, 'real config.toml carries the selected effort').toContain('model_reasoning_effort = "high"');
    expect(configText, 'real config.toml carries command auth on Unix').toContain('command = "sh"');
    expect(configText, 'the provider token is kept outside config.toml').not.toContain(SENTINEL_KEY);
    expect(run.combined, 'the provider token is never logged').not.toContain(SENTINEL_KEY);
    assertStagedToken(ws, codexHome);
  });
}
