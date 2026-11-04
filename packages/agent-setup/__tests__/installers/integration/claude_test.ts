import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { ALL_BASH_FRAGMENTS, ALL_POWERSHELL_FRAGMENTS, HARNESS_ROOT, SENTINEL_KEY, SHIM_BIN, backupFiles, bothConfig, claudeConfig, codexConfigPath, codexTokenPath, hostPwsh, installerChildPid, installerMarker, makeWorkspace, modelServer, networkReachable, placeFakeClaude, placeFakeNpm, powerShellBody, powerShellCallerSurvivalPath, powerShellEntry, powerShellLiteral, processExists, readSettings, runPowerShellInstaller, runShellInstaller, runShellInstallerWithAmbientKey, settingsPathFor, shellBody, shellEntry, stagedFiles } from './harness';
import type { RunResult } from './harness';
import { renderPowerShellPrefix, renderShellPrefix } from '../../../src/render.ts';
import { SETUP_BASH_CLAUDE, SETUP_BASH_CODEX, SETUP_POWERSHELL_CLAUDE, SETUP_POWERSHELL_CODEX, SETUP_POWERSHELL_COMMON } from '../../../src/script-assets.generated.ts';

test('existing CLI is used and the installer hook is not called', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code, `installer should succeed:\n${run.combined}`).toBe(0);
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
  const settings = readSettings(settingsPathFor(ws)) as { env: Record<string, string> };
  expect(settings.env.ANTHROPIC_BASE_URL, 'base URL is written').toBe(modelServer.url);
  expect(settings.env.ANTHROPIC_AUTH_TOKEN, 'auth token is written').toBe(SENTINEL_KEY);
});

test('missing CLI triggers the configured installer hook', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, forceColor: true });
  expect(run.code, `installer should succeed after install:\n${run.combined}`).toBe(0);
  expect(existsSync(installerMarker(ws))).toBeTruthy();
  expect(existsSync(join(ws.home, '.local/bin/claude'))).toBeTruthy();
  expect(existsSync(settingsPathFor(ws))).toBeTruthy();
  const installLine = run.stdout.split(/\r?\n/).find(line => line.includes('Claude Code CLI not found; running the test installer'));
  expect(installLine, 'normal installation information carries no prefix or styling').toBe('Claude Code CLI not found; running the test installer');
});

test('npm is preferred over the direct installer when npm is available', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, withInstallHook: false });
  expect(run.code, `npm installation should succeed:\n${run.combined}`).toBe(0);
  expect(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'npm receives the official global package').toBe('install --global @anthropic-ai/claude-code');
  expect(run.stdout, 'the selected installation source is reported plainly').toContain('Claude Code CLI not found; installing with npm');
});

test('unrelated settings and env keys are preserved', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({
    theme: 'dark',
    permissions: { allow: ['Bash(ls:*)'] },
    attribution: { keep: 'yes' },
    env: { OTHER_TOOL: 'keep-me', USE_BUILTIN_RIPGREP: '0' },
  }));
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url,
    configuration: claudeConfig({ model: 'claude-opus-x[1m]', defaultFableModel: 'fable-x', defaultOpusModel: 'opus-x', defaultSonnetModel: 'sonnet-x', defaultHaikuModel: 'haiku-x', effortLevel: 'high', cleanupPeriodDays: 365, optOutAiAttribution: true, disableAutoMemory: true, disableAgentView: true, disableArtifact: true, modelDiscovery: true }),
  });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  const settings = readSettings(settingsPathFor(ws)) as { theme: string; permissions: unknown; effortLevel: string; cleanupPeriodDays: number; autoMemoryEnabled: boolean; disableAgentView: boolean; enableArtifact: boolean; disableArtifact: boolean; attribution: Record<string, unknown>; env: Record<string, string> };
  expect(settings.theme, 'unrelated top-level key preserved').toBe('dark');
  expect(JSON.stringify(settings.permissions), 'unrelated nested object preserved').toBe(JSON.stringify({ allow: ['Bash(ls:*)'] }));
  expect(settings.env.OTHER_TOOL, 'unrelated env key preserved').toBe('keep-me');
  expect(settings.env.USE_BUILTIN_RIPGREP, 'unrelated env key preserved').toBe('0');
  expect(settings.env.ANTHROPIC_MODEL, 'managed model written verbatim').toBe('claude-opus-x[1m]');
  expect(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'managed fable default written').toBe('fable-x');
  expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'managed opus default written').toBe('opus-x');
  expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'managed sonnet default written').toBe('sonnet-x');
  expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'managed haiku default written').toBe('haiku-x');
  expect(settings.cleanupPeriodDays, 'cleanupPeriodDays maps to the top-level numeric setting').toBe(365);
  expect(settings.autoMemoryEnabled, 'the auto-memory opt-out maps to autoMemoryEnabled: false').toBe(false);
  expect(settings.disableAgentView, 'the agent-view opt-out maps to disableAgentView: true').toBe(true);
  expect(settings.enableArtifact, 'the artifact opt-out maps to enableArtifact: false').toBe(false);
  expect(settings.disableArtifact, 'the artifact opt-out also writes the pre-2.1.242 disableArtifact: true').toBe(true);
  expect(JSON.stringify(settings.attribution), 'attribution opt-out values are written without replacing unrelated keys').toBe(JSON.stringify({ keep: 'yes', commit: '', pr: '', sessionUrl: false }));
});

test('optional keys are removed when unset', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({
    effortLevel: 'high',
    cleanupPeriodDays: 180,
    autoMemoryEnabled: false,
    disableAgentView: true,
    enableArtifact: false,
    disableArtifact: true,
    attribution: { commit: 'stale-commit', pr: 'stale-pr', sessionUrl: true, keep: 'yes' },
    env: {
      ANTHROPIC_MODEL: 'stale-model',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'stale-fable',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'stale-opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'stale-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'stale-haiku',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      KEEP: 'yes',
    },
  }));
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  const settings = readSettings(settingsPathFor(ws)) as { effortLevel?: string; cleanupPeriodDays?: number; attribution: Record<string, unknown>; env: Record<string, string> };
  expect(!('ANTHROPIC_MODEL' in settings.env)).toBeTruthy();
  expect(!('ANTHROPIC_DEFAULT_FABLE_MODEL' in settings.env)).toBeTruthy();
  expect(!('ANTHROPIC_DEFAULT_OPUS_MODEL' in settings.env)).toBeTruthy();
  expect(!('ANTHROPIC_DEFAULT_SONNET_MODEL' in settings.env)).toBeTruthy();
  expect(!('ANTHROPIC_DEFAULT_HAIKU_MODEL' in settings.env)).toBeTruthy();
  expect(!('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' in settings.env)).toBeTruthy();
  expect(!('effortLevel' in settings)).toBeTruthy();
  expect(!('cleanupPeriodDays' in settings)).toBeTruthy();
  expect(!('autoMemoryEnabled' in settings)).toBeTruthy();
  expect(!('disableAgentView' in settings)).toBeTruthy();
  expect(settings).not.toHaveProperty('enableArtifact');
  expect(settings).not.toHaveProperty('disableArtifact');
  expect(JSON.stringify(settings.attribution), 'managed attribution keys removed while unrelated keys survive').toBe(JSON.stringify({ keep: 'yes' }));
  expect(settings.env.KEEP, 'unrelated env key preserved through removal').toBe('yes');
});

test('effort and discovery map to the documented keys', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig({ effortLevel: 'xhigh', cleanupPeriodDays: 99999, modelDiscovery: true }), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  const settings = readSettings(settingsPathFor(ws)) as { effortLevel: string; cleanupPeriodDays: number; env: Record<string, string> };
  expect(settings.effortLevel, 'effortLevel maps to the top-level key').toBe('xhigh');
  expect(settings.cleanupPeriodDays, 'cleanupPeriodDays remains numeric').toBe(99999);
  expect(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, 'discovery maps to the documented env key with value "1"').toBe('1');
});

test('written settings file has 0600 permissions and a 0700 config dir', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  const fileMode = statSync(settingsPathFor(ws)).mode & 0o777;
  expect(fileMode, `settings.json should be 0600, got ${fileMode.toString(8)}`).toBe(0o600);
  const dirMode = statSync(join(ws.home, '.claude')).mode & 0o777;
  expect(dirMode, `config dir should be 0700, got ${dirMode.toString(8)}`).toBe(0o700);
});

test('a pre-existing settings file is backed up', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light', env: { KEEP: '1' } });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  const backups = backupFiles(configDir);
  expect(backups.length, `exactly one backup expected, found ${backups.join(', ')}`).toBe(1);
  expect(readFileSync(join(configDir, backups[0]!), 'utf8'), 'backup captures the original bytes').toBe(original);
});

test('successful re-runs retain only the latest settings backup', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({ theme: 'original' }));

  const first = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(first.code, `first run should succeed:\n${first.combined}`).toBe(0);
  const firstSettings = readFileSync(settingsPathFor(ws), 'utf8');
  const second = await runShellInstaller({ workspace: ws, configuration: claudeConfig({ effortLevel: 'high' }), baseUrl: modelServer.url });
  expect(second.code, `second run should succeed:\n${second.combined}`).toBe(0);

  const backups = backupFiles(configDir);
  expect(backups.length, `only the latest backup is retained, found ${backups.join(', ')}`).toBe(1);
  expect(readFileSync(join(configDir, backups[0]!), 'utf8'), 'the retained backup is the state before the latest run').toBe(firstSettings);
});

test('invalid existing JSON fails without mutating the file', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const broken = '{ this is not valid json';
  writeFileSync(settingsPathFor(ws), broken);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code !== 0).toBeTruthy();
  expect(readFileSync(settingsPathFor(ws), 'utf8'), 'the invalid file is left untouched').toBe(broken);
  expect(backupFiles(configDir).length, 'no backup is created when validation fails before mutation').toBe(0);
  expect(stagedFiles(configDir).length, 'no staged file is left behind').toBe(0);
});

test('present null env fails closed without mutating the file', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light', env: null });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code !== 0).toBeTruthy();
  expect(readFileSync(settingsPathFor(ws), 'utf8'), 'the file is left untouched').toBe(original);
  expect(backupFiles(configDir).length, 'no backup is created before validation').toBe(0);
});

test('an interrupt during the Claude install stops the selected script and cleans up', { timeout: 180_000 }, async () => {
  for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const ws = makeWorkspace();
    // No fake claude on PATH, so the agent fragment runs the sleeping installer;
    // the signal lands while it is mid-install.
    const run = await runShellInstaller({
      workspace: ws, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'claude',
      installerSleep: 5, signalDuringInstall: signal,
    });
    expect(run.code, `${signal} must exit ${expectedCode}, not resume:\n${run.combined}`).toBe(expectedCode);
    expect(run.combined, `${signal}: the run had entered the Claude phase`).toContain('Claude Code');
    expect(run.combined, `${signal}: the run must never reach the Codex phase`).not.toContain('Codex');
    expect(!existsSync(codexConfigPath(ws))).toBeTruthy();
    expect(!existsSync(codexTokenPath(ws))).toBeTruthy();
    const remnants = readdirSync(ws.root).filter(name => name.startsWith('agent-setup.'));
    expect(remnants.length, `${signal}: the EXIT trap cleaned the private working directory`).toBe(0);
  }
});

test('raw claude --version output is displayed', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, fakeClaudeVersion: '2.4.1 (Claude Code)' });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'the raw version string is surfaced').toContain('2.4.1 (Claude Code)');
});

test('multiple installations produce a warning and PATH wins', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  placeFakeClaude(join(ws.home, '.local/bin'));
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined.toLowerCase(), 'a multiple-installation warning is printed').toContain('multiple');
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
});

test('the API key never appears in stdout or stderr', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url,
    configuration: claudeConfig({ model: 'claude-opus-x', effortLevel: 'high', modelDiscovery: true }),
  });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'the API key must never be printed').not.toContain(SENTINEL_KEY);
  // Sanity: the key really was consumed and written, so the absence above is
  // meaningful rather than the key simply never being used.
  const settings = readSettings(settingsPathFor(ws)) as { env: Record<string, string> };
  expect(settings.env.ANTHROPIC_AUTH_TOKEN, 'the key was actually written to settings').toBe(SENTINEL_KEY);
});

test('ambient exported API key is removed before installer and CLI subprocesses', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  const run = await runShellInstallerWithAmbientKey({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code, `ambient key must be removed before child processes:\n${run.combined}`).toBe(0);
  expect(existsSync(installerMarker(ws))).toBeTruthy();
});

test('setup performs no gateway request', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  modelServer.reset();
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(modelServer.requests.length, 'installation and configuration remain entirely local').toBe(0);
});

test('honors an explicit CLAUDE_CONFIG_DIR', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.root, 'custom-config');
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, configDir });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(existsSync(join(configDir, 'settings.json'))).toBeTruthy();
  expect(!existsSync(join(ws.home, '.claude', 'settings.json'))).toBeTruthy();
});

test('missing jq without a download fails before mutating settings', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light' });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, includeJq: false, disableJqDownload: true });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined.toLowerCase(), 'the failure names the jq requirement').toContain('jq');
  expect(readFileSync(settingsPathFor(ws), 'utf8'), 'settings are left untouched when jq is unavailable').toBe(original);
  expect(backupFiles(configDir).length, 'no backup is created before the jq check').toBe(0);
});

test('jq is bootstrapped from the pinned release when absent from PATH', { timeout: 180_000 }, async ({ skip }) => {
  if (!networkReachable()) return skip(true, 'GitHub jq release is unreachable; skipping the online bootstrap test');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig({ modelDiscovery: true }), baseUrl: modelServer.url, includeJq: false });
  expect(run.code, `bootstrapped jq should configure successfully:\n${run.combined}`).toBe(0);
  expect(run.stderr, 'automatic jq recovery is presented as a non-blocking warning').toContain('Warning: jq not found on PATH; fetching the pinned jq-1.8.2 build');
  const settings = readSettings(settingsPathFor(ws)) as { env: Record<string, string> };
  expect(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, 'the bootstrapped jq produced correct output').toBe('1');
});

// --- PowerShell parse + execution ------------------------------------------

test('PowerShell installer body parses without syntax errors', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const body = powerShellBody('claude');
  const entry = powerShellEntry('claude');
  expect(body.trimEnd().endsWith(entry)).toBeTruthy();
  expect(body.lastIndexOf(entry) > body.indexOf('function Set-SetupAgent {')).toBeTruthy();
  const script = renderPowerShellPrefix({
    agent: 'claude',
    apiKey: SENTINEL_KEY,
    apiKeyName: 'Primary key',
    configuration: claudeConfig({ model: 'claude-opus-x', effortLevel: 'high', modelDiscovery: true }),
  }) + body;
  const scriptPath = join(HARNESS_ROOT, 'parse-check.ps1');
  writeFileSync(scriptPath, script);
  const check = `$errs=$null; [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}',[ref]$null,[ref]$errs); if($errs -and $errs.Count -gt 0){ $errs | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 } else { exit 0 }`;
  const result = spawnSync(hostPwsh, ['-NoProfile', '-Command', check], { encoding: 'utf8' });
  expect(result.status, `PowerShell parse errors:\n${result.stdout}${result.stderr}`).toBe(0);
});

test('PowerShell: existing CLI configures and preserves unrelated keys', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({ theme: 'dark', attribution: { keep: 'yes' }, env: { OTHER_TOOL: 'keep-me' } }));
  const run = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url,
    configuration: claudeConfig({ model: 'claude-opus-x[1m]', defaultFableModel: 'fable-x', defaultOpusModel: 'opus-x', defaultSonnetModel: 'sonnet-x', effortLevel: 'high', cleanupPeriodDays: 180, optOutAiAttribution: true, disableAutoMemory: true, disableAgentView: true, disableArtifact: true, modelDiscovery: true }),
  });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(existsSync(powerShellCallerSurvivalPath(ws))).toBeTruthy();
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
  const settings = readSettings(settingsPathFor(ws)) as { theme: string; effortLevel: string; cleanupPeriodDays: number; autoMemoryEnabled: boolean; disableAgentView: boolean; enableArtifact: boolean; disableArtifact: boolean; attribution: Record<string, unknown>; env: Record<string, string> };
  expect(settings.theme, 'unrelated top-level key preserved').toBe('dark');
  expect(settings.env.OTHER_TOOL, 'unrelated env key preserved').toBe('keep-me');
  expect(settings.env.ANTHROPIC_BASE_URL, 'base URL written').toBe(modelServer.url);
  expect(settings.env.ANTHROPIC_AUTH_TOKEN, 'auth token written').toBe(SENTINEL_KEY);
  expect(settings.env.ANTHROPIC_MODEL, 'model written verbatim').toBe('claude-opus-x[1m]');
  expect(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'fable default written').toBe('fable-x');
  expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'opus default written').toBe('opus-x');
  expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'sonnet default written').toBe('sonnet-x');
  expect(settings.effortLevel, 'effortLevel maps to the top-level key').toBe('high');
  expect(settings.cleanupPeriodDays, 'cleanupPeriodDays maps to the top-level numeric setting').toBe(180);
  expect(settings.autoMemoryEnabled, 'the auto-memory opt-out maps to autoMemoryEnabled: false').toBe(false);
  expect(settings.disableAgentView, 'the agent-view opt-out maps to disableAgentView: true').toBe(true);
  expect(settings.enableArtifact, 'the artifact opt-out maps to enableArtifact: false').toBe(false);
  expect(settings.disableArtifact, 'the artifact opt-out also writes the pre-2.1.242 disableArtifact: true').toBe(true);
  expect(JSON.stringify(settings.attribution), 'attribution opt-out maps to the documented values').toBe(JSON.stringify({ keep: 'yes', commit: '', pr: '', sessionUrl: false }));
  expect(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, 'discovery maps to the documented env key').toBe('1');
});

test('PowerShell: optional keys are removed when unset', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({
    effortLevel: 'high',
    cleanupPeriodDays: 365,
    autoMemoryEnabled: false,
    disableAgentView: true,
    enableArtifact: false,
    disableArtifact: true,
    attribution: { commit: 'stale', pr: 'stale', sessionUrl: true, keep: 'yes' },
    env: { ANTHROPIC_MODEL: 'stale', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1', KEEP: 'yes' },
  }));
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  const settings = readSettings(settingsPathFor(ws)) as { effortLevel?: string; cleanupPeriodDays?: number; attribution: Record<string, unknown>; env: Record<string, string> };
  expect(!('ANTHROPIC_MODEL' in settings.env)).toBeTruthy();
  expect(!('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' in settings.env)).toBeTruthy();
  expect(!('effortLevel' in settings)).toBeTruthy();
  expect(!('cleanupPeriodDays' in settings)).toBeTruthy();
  expect(!('autoMemoryEnabled' in settings)).toBeTruthy();
  expect(!('disableAgentView' in settings)).toBeTruthy();
  expect(settings).not.toHaveProperty('enableArtifact');
  expect(settings).not.toHaveProperty('disableArtifact');
  expect(JSON.stringify(settings.attribution), 'managed attribution keys removed while unrelated keys survive').toBe(JSON.stringify({ keep: 'yes' }));
  expect(settings.env.KEEP, 'unrelated env key preserved').toBe('yes');
});

test('PowerShell: existing permissive settings are replaced with mode 0600 on Unix', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({ theme: 'light', env: { KEEP: '1' } }));
  chmodSync(settingsPathFor(ws), 0o644);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(statSync(settingsPathFor(ws)).mode & 0o777, 'replacement settings must be mode 0600').toBe(0o600);
});

test('PowerShell: chmod failure leaves original untouched and no secret stage', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light', env: { KEEP: '1' } });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, fakeChmodFailure: true,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(readFileSync(settingsPathFor(ws), 'utf8'), 'original settings must remain untouched').toBe(original);
  expect(stagedFiles(configDir).length, 'failed protected stage must be removed').toBe(0);
  expect(backupFiles(configDir).length, 'failed pre-mutation backup must be removed').toBe(0);
  expect(run.combined, 'chmod failure logs must not expose the key').not.toContain(SENTINEL_KEY);
});

test('PowerShell: a pre-existing settings file is backed up', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light', env: { KEEP: '1' } });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  const backups = backupFiles(configDir);
  expect(backups.length, `exactly one backup expected, found ${backups.join(', ')}`).toBe(1);
  expect(readFileSync(join(configDir, backups[0]!), 'utf8'), 'backup captures the original bytes').toBe(original);
});

test('PowerShell: successful re-runs retain only the latest settings backup', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({ theme: 'original' }));

  const first = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(first.code, `first run should succeed:\n${first.combined}`).toBe(0);
  const firstSettings = readFileSync(settingsPathFor(ws), 'utf8');
  const second = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig({ effortLevel: 'high' }), baseUrl: modelServer.url });
  expect(second.code, `second run should succeed:\n${second.combined}`).toBe(0);

  const backups = backupFiles(configDir);
  expect(backups.length, `only the latest backup is retained, found ${backups.join(', ')}`).toBe(1);
  expect(readFileSync(join(configDir, backups[0]!), 'utf8'), 'the retained backup is the state before the latest run').toBe(firstSettings);
});

test('PowerShell: existing settings use File.Replace with a real null backup path', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), JSON.stringify({ theme: 'light' }));
  const run = await runPowerShellInstaller({
    workspace: ws,
    configuration: claudeConfig(),
    baseUrl: modelServer.url,
    forcePowerShellWindowsReplacement: true,
  });
  expect(run.code, `File.Replace should succeed:\n${run.combined}`).toBe(0);
  const settings = readSettings(settingsPathFor(ws)) as { env: Record<string, string> };
  expect(settings.env.ANTHROPIC_AUTH_TOKEN, 'the replacement carries the selected key').toBe(SENTINEL_KEY);
});

test('PowerShell: invalid existing JSON fails without mutating the file', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const broken = '{ not valid json';
  writeFileSync(settingsPathFor(ws), broken);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code !== 0).toBeTruthy();
  expect(existsSync(powerShellCallerSurvivalPath(ws))).toBeTruthy();
  expect(readFileSync(settingsPathFor(ws), 'utf8'), 'the invalid file is left untouched').toBe(broken);
  expect(backupFiles(configDir).length, 'no backup is created when validation fails before mutation').toBe(0);
});

test('PowerShell: present null env fails closed without mutation', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light', env: null });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code !== 0).toBeTruthy();
  expect(readFileSync(settingsPathFor(ws), 'utf8'), 'the file is left untouched').toBe(original);
  expect(backupFiles(configDir).length, 'no backup is created before validation').toBe(0);
});

test('PowerShell stages secret data only after protection and hardens Windows replacement targets', { timeout: 180_000 }, async () => {
  const body = powerShellBody('claude');
  const createIndex = body.indexOf('[System.IO.File]::Create($stage).Dispose()');
  const protectStageIndex = body.indexOf('Protect-SetupFile $stage', createIndex);
  const writeIndex = body.indexOf('[System.IO.File]::WriteAllText($stage, $json', protectStageIndex);
  const protectTargetIndex = body.indexOf('Protect-SetupFile $script:ClaudeSettingsPath', writeIndex);
  const replaceIndex = body.indexOf('[System.IO.File]::Replace($stage, $script:ClaudeSettingsPath, [System.Management.Automation.Language.NullString]::Value)', protectTargetIndex);
  expect(createIndex >= 0 && createIndex < protectStageIndex).toBeTruthy();
  expect(protectStageIndex < writeIndex).toBeTruthy();
  expect(protectTargetIndex < replaceIndex).toBeTruthy();
  expect(body, 'the shared predicate recognizes Windows PowerShell 5.1 without reading an absent $IsWindows').toContain('($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows');
  expect(body, 'the replacement path uses the shared Windows predicate').toContain('$runningOnWindows = Test-SetupIsWindows');
  expect(body, 'backup timestamp must support the .NET Framework used by PowerShell 5.1').toContain("[long]([DateTimeOffset]::UtcNow - [DateTimeOffset]'1970-01-01T00:00:00Z').TotalMilliseconds");
  expect(body, 'PowerShell 5.1-incompatible timestamp API must not be used').not.toContain('ToUnixTimeMilliseconds()');
  expect(body, 'new target must use a same-directory move').toContain('Move-Item -LiteralPath $stage -Destination $script:ClaudeSettingsPath');
});

test('PowerShell Windows file protection writes only an owner DACL', { timeout: 180_000 }, () => {
  const helperStart = SETUP_POWERSHELL_COMMON.indexOf('function Protect-SetupFile');
  const helperEnd = SETUP_POWERSHELL_COMMON.indexOf('\nfunction ', helperStart);
  expect(helperStart >= 0).toBeTruthy();
  expect(helperEnd >= 0).toBeTruthy();
  const helper = SETUP_POWERSHELL_COMMON.slice(helperStart, helperEnd);
  expect(helper, 'a fresh descriptor carries no prior access rules').toContain('New-Object System.Security.AccessControl.FileSecurity');
  expect(helper, 'the current user receives the sole allow rule').toContain("FileSystemAccessRule($identity, 'FullControl', 'Allow')");
  expect(helper, 'Windows PowerShell 5.1 writes the descriptor directly').toContain('[System.IO.File]::SetAccessControl($Path, $acl)');
  expect(helper, 'PowerShell 7 writes the descriptor through the .NET extension').toContain('[System.IO.FileSystemAclExtensions]::SetAccessControl');
  expect(helper, 'the filesystem provider cannot request an SACL write').not.toContain('\n  Set-Acl ');
});

test('PowerShell: missing CLI triggers the installer', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code, `should succeed after install:\n${run.combined}`).toBe(0);
  expect(existsSync(installerMarker(ws))).toBeTruthy();
  expect(existsSync(settingsPathFor(ws))).toBeTruthy();
});

test('PowerShell prefers npm over the direct installer when npm is available', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeNpm(ws);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, withInstallHook: false });
  expect(run.code, `npm installation should succeed:\n${run.combined}`).toBe(0);
  expect(readFileSync(join(ws.root, 'npm-record.txt'), 'utf8').trim(), 'npm receives the official global package').toBe('install --global @anthropic-ai/claude-code');
});

test('local Bash installer accepts shell content and rejects HTML', { timeout: 180_000 }, async () => {
  const accepted = makeWorkspace();
  modelServer.mode = 'installer-sh';
  const success = await runShellInstaller({
    workspace: accepted, configuration: claudeConfig(), baseUrl: modelServer.url,
    withInstallHook: false, installerUrl: `${modelServer.url}/install.sh`,
  });
  expect(success.code, `a local shell installer should be accepted:\n${success.combined}`).toBe(0);
  expect(existsSync(installerMarker(accepted))).toBeTruthy();

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runShellInstaller({
    workspace: rejected, configuration: claudeConfig(), baseUrl: modelServer.url,
    withInstallHook: false, installerUrl: `${modelServer.url}/install.sh`,
  });
  expect(failure.code !== 0).toBeTruthy();
  expect(!existsSync(installerMarker(rejected))).toBeTruthy();
});

test('local PowerShell installer accepts script content and rejects HTML', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const accepted = makeWorkspace();
  modelServer.mode = 'installer-ps1';
  const success = await runPowerShellInstaller({
    workspace: accepted, configuration: claudeConfig(), baseUrl: modelServer.url,
    withInstallHook: false, installerUrl: `${modelServer.url}/install.ps1`,
  });
  expect(success.code, `a local PowerShell installer should be accepted:\n${success.combined}`).toBe(0);
  expect(existsSync(installerMarker(accepted))).toBeTruthy();

  const rejected = makeWorkspace();
  modelServer.mode = 'installer-html';
  const failure = await runPowerShellInstaller({
    workspace: rejected, configuration: claudeConfig(), baseUrl: modelServer.url,
    withInstallHook: false, installerUrl: `${modelServer.url}/install.ps1`,
  });
  expect(failure.code !== 0).toBeTruthy();
  expect(!existsSync(installerMarker(rejected))).toBeTruthy();
});

test('Bash fallback kills the installer process tree', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  const started = Date.now();
  const run = await runShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url,
    installerSleep: 5, timeoutSeconds: 1, excludeTimeoutTools: true,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(Date.now() - started < 4_000).toBeTruthy();
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
  expect(existsSync(installerChildPid(ws))).toBeTruthy();
  const childPid = Number(readFileSync(installerChildPid(ws), 'utf8').trim());
  expect(!processExists(childPid)).toBeTruthy();
  expect(run.combined, 'controlled PATH must select the Bash fallback').toContain('timeout fallback: process-tree');
});

test('Bash claude --version is bounded before configuration', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const started = Date.now();
  const run = await runShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url,
    fakeClaudeVersionSleep: 8, timeoutSeconds: 1, excludeTimeoutTools: true,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(Date.now() - started < 4_000).toBeTruthy();
  expect(!existsSync(settingsPathFor(ws))).toBeTruthy();
});

test('PowerShell downloaded installer is bounded', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  modelServer.mode = 'installer-ps1';
  const started = Date.now();
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url,
    withInstallHook: false, installerUrl: `${modelServer.url}/install.ps1`, installerSleep: 12, timeoutSeconds: 1,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(Date.now() - started < 8_000).toBeTruthy();
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
  expect(existsSync(installerChildPid(ws))).toBeTruthy();
  const childPid = Number(readFileSync(installerChildPid(ws), 'utf8').trim());
  expect(!processExists(childPid)).toBeTruthy();
});

test('PowerShell claude --version is bounded', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const started = Date.now();
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url,
    fakeClaudeVersionSleep: 12, timeoutSeconds: 1,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(Date.now() - started < 8_000).toBeTruthy();
  expect(!existsSync(settingsPathFor(ws))).toBeTruthy();
});

test('PowerShell removes an ambient exported API key before installer and CLI subprocesses', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  const run = await runPowerShellInstaller({
    workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, ambientApiKey: true,
  });
  expect(run.code, `ambient key must be removed before child processes:\n${run.combined}`).toBe(0);
  expect(existsSync(installerMarker(ws))).toBeTruthy();
});

test('PowerShell keeps the API key out of output and performs no gateway request', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  modelServer.reset();
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig({ model: 'claude-opus-x', effortLevel: 'high' }), baseUrl: modelServer.url });
  expect(run.code, `should succeed:\n${run.combined}`).toBe(0);
  expect(run.combined, 'the API key must never be printed').not.toContain(SENTINEL_KEY);
  const settings = readSettings(settingsPathFor(ws)) as { env: Record<string, string> };
  expect(settings.env.ANTHROPIC_AUTH_TOKEN, 'the key was actually written to settings').toBe(SENTINEL_KEY);
  expect(modelServer.requests.length, 'installation and configuration remain entirely local').toBe(0);
});

// --- Bash 3.2 syntax check --------------------------------------------------

test('platform installers prefer Homebrew then npm on macOS and npm then direct scripts elsewhere', { timeout: 180_000 }, () => {
  expect(ALL_BASH_FRAGMENTS, 'the Bash installer uses Homebrew on macOS').toContain('brew install --cask');
  expect(ALL_BASH_FRAGMENTS, 'the Bash installer can install global npm packages').toContain('npm install --global "$_inp_package"');
  expect(SETUP_BASH_CLAUDE, 'the Claude fragment names its official npm package').toContain("'@anthropic-ai/claude-code'");
  expect(SETUP_BASH_CLAUDE, 'the Claude fragment excludes Codex').not.toContain('@openai/codex');
  expect(SETUP_BASH_CODEX, 'the Codex fragment names its official npm package').toContain("'@openai/codex'");
  expect(SETUP_BASH_CODEX, 'the Codex fragment excludes Claude Code').not.toContain('@anthropic-ai/claude-code');
  expect(SETUP_BASH_CLAUDE, 'Claude Linux uses the direct release bootstrap').toContain('https://downloads.claude.ai/claude-code-releases/bootstrap.sh');
  expect(SETUP_BASH_CODEX, 'Codex Linux uses the GitHub source installer').toContain('https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.sh');
  const shClaude = SETUP_BASH_CLAUDE.slice(SETUP_BASH_CLAUDE.indexOf('claude_ensure_installed()'), SETUP_BASH_CLAUDE.indexOf('claude_write_settings()'));
  expect(shClaude.indexOf('command -v brew') < shClaude.indexOf('command -v npm')).toBeTruthy();
  expect(shClaude.indexOf('command -v npm') < shClaude.indexOf('bootstrap.sh')).toBeTruthy();
  const shCodex = SETUP_BASH_CODEX.slice(SETUP_BASH_CODEX.indexOf('codex_ensure_installed()'), SETUP_BASH_CODEX.indexOf('codex_backup_files()'));
  expect(shCodex.indexOf('command -v brew') < shCodex.indexOf('command -v npm')).toBeTruthy();
  expect(shCodex.indexOf('command -v npm') < shCodex.indexOf('install.sh')).toBeTruthy();
  expect(SETUP_POWERSHELL_CLAUDE, 'PowerShell can install Claude Code with npm').toContain("Install-SetupNpmPackage -Package '@anthropic-ai/claude-code'");
  expect(SETUP_POWERSHELL_CODEX, 'PowerShell can install Codex with npm').toContain("Install-SetupNpmPackage -Package '@openai/codex'");
  expect(SETUP_POWERSHELL_CLAUDE, 'Claude Windows uses the direct release bootstrap').toContain('https://downloads.claude.ai/claude-code-releases/bootstrap.ps1');
  expect(SETUP_POWERSHELL_CODEX, 'Codex Windows uses the GitHub source installer').toContain('https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.ps1');
  expect(ALL_POWERSHELL_FRAGMENTS, 'downloaded PowerShell scripts prefer pwsh when it is installed').toContain('Get-Command pwsh');
});

test('Bash installer body parses under the macOS Bash 3.2 baseline', { timeout: 180_000 }, async () => {
  const body = shellBody('claude');
  const entry = shellEntry('claude');
  expect(body.trimEnd().endsWith(entry)).toBeTruthy();
  expect(body.lastIndexOf(entry) > body.indexOf('configure_agent() {')).toBeTruthy();
  const script = renderShellPrefix({ agent: 'claude', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration: claudeConfig({ model: 'm', effortLevel: 'high', modelDiscovery: true }) }) + body;
  const scriptPath = join(HARNESS_ROOT, 'syntax-check.sh');
  writeFileSync(scriptPath, script);
  const result = spawnSync('/bin/bash', ['-n', scriptPath], { encoding: 'utf8' });
  expect(result.status, `/bin/bash -n reported a syntax error:\n${result.stderr}`).toBe(0);
});

test('a download that ends before the final main call performs no setup work', { timeout: 180_000 }, () => {
  const ws = makeWorkspace();
  const configuration = claudeConfig();
  const body = shellBody('claude');
  const bodyWithoutEntry = body.slice(0, body.lastIndexOf(shellEntry('claude')));
  const script = renderShellPrefix({ agent: 'claude', apiKey: SENTINEL_KEY, apiKeyName: 'Primary key', configuration }) + bodyWithoutEntry;
  const scriptPath = join(ws.root, 'truncated-setup.sh');
  writeFileSync(scriptPath, script);
  const result = spawnSync('/bin/bash', [scriptPath], {
    encoding: 'utf8',
    env: { HOME: ws.home, PATH: [ws.binDir, SHIM_BIN].join(':'), SETUP_ENDPOINT: modelServer.url },
  });
  expect(result.status, `definitions-only script should exit cleanly:\n${result.stderr}`).toBe(0);
  expect(result.stdout, 'definitions-only script prints nothing').toBe('');
  expect(!existsSync(settingsPathFor(ws))).toBeTruthy();
  expect(!existsSync(installerMarker(ws))).toBeTruthy();
});

// --- base URL injection -----------------------------------------------------

// A raw shell run of an arbitrary command line, sharing the async model-server
// event loop. Used to exercise the exact copyable command a user pastes, so the
// `export SETUP_ENDPOINT` / `$SetupEndpoint` injection and the `| bash` / `| iex`
// pipeline scoping are verified end to end rather than assumed.
const runCommandLine = (exe: string, args: string[], command: string): Promise<RunResult> =>
  new Promise<RunResult>(resolve => {
    const child = spawn(exe, [...args, command], { env: { PATH: `${SHIM_BIN}:${process.env.PATH ?? ''}` } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}`, combined: `${stdout}${stderr}${String(error)}` }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr, combined: `${stdout}${stderr}` }));
  });

test('the copyable Bash command exports the origin into the piped installer body', { timeout: 180_000 }, async () => {
  const origin = modelServer.url;
  const command = `export SETUP_ENDPOINT='${origin.replace(/'/g, "'\\''")}'; curl -fsSL "$SETUP_ENDPOINT/probe/setup.sh" | bash`;
  const run = await runCommandLine('/bin/bash', ['-c'], command);
  expect(run.code, `the copyable Bash command should run cleanly:\n${run.combined}`).toBe(0);
  expect(run.stdout, 'the exported origin reached the piped bash executing the fetched body').toContain(`PROBE_BASE_URL=[${origin}]`);
});

test('the copyable PowerShell command assigns the origin into the iex runspace', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const origin = modelServer.url;
  const command = `$SetupEndpoint = ${powerShellLiteral(origin)}; irm "$SetupEndpoint/probe/setup.ps1" | iex`;
  const run = await runCommandLine(hostPwsh, ['-NoProfile', '-Command'], command);
  expect(run.code, `the copyable PowerShell command should run cleanly:\n${run.combined}`).toBe(0);
  expect(run.stdout, 'the in-process origin reached the iex-executed fetched body').toContain(`PROBE_BASE_URL=[${origin}]`);
});

test('a missing SETUP_ENDPOINT fails before any mutation', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light' });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, omitBaseUrl: true });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'the failure names the required base URL').toContain('SETUP_ENDPOINT');
  expect(readFileSync(settingsPathFor(ws), 'utf8'), 'settings are left untouched').toBe(original);
  expect(backupFiles(configDir).length, 'no backup is created before the base-URL guard').toBe(0);
});

test('a non-http(s) SETUP_ENDPOINT fails before any mutation', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light' });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, baseUrlOverride: 'ftp://not-http' });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'the failure explains the origin requirement').toContain('http(s) origin');
  expect(readFileSync(settingsPathFor(ws), 'utf8'), 'settings are left untouched').toBe(original);
  expect(backupFiles(configDir).length, 'no backup is created before the base-URL guard').toBe(0);
});

test('PowerShell: a missing $SetupEndpoint fails before any mutation', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light' });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, omitBaseUrl: true });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'the failure names the required endpoint').toContain('SetupEndpoint');
  expect(readFileSync(settingsPathFor(ws), 'utf8'), 'settings are left untouched').toBe(original);
  expect(backupFiles(configDir).length, 'no backup is created before the base-URL guard').toBe(0);
});

test('PowerShell: a non-http(s) $SetupEndpoint fails before any mutation', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  const original = JSON.stringify({ theme: 'light' });
  writeFileSync(settingsPathFor(ws), original);
  const run = await runPowerShellInstaller({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url, baseUrlOverride: 'ftp://not-http' });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'the failure explains the origin requirement').toContain('http(s) origin');
  expect(readFileSync(settingsPathFor(ws), 'utf8'), 'settings are left untouched').toBe(original);
  expect(backupFiles(configDir).length, 'no backup is created before the base-URL guard').toBe(0);
});
