import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { SENTINEL_KEY, SHIM_BIN, backupFiles, bothConfig, claudeConfig, codexConfigPath, codexTokenPath, hostPwsh, installerChildPid, installerMarker, makeWorkspace, modelServer, placeFakeClaude, powerShellCallerSurvivalPath, processExists, readSettings, runPowerShellInstaller, runShellInstaller, runShellInstallerWithAmbientKey, settingsPathFor, shellBody, shellEntry, stagedFiles } from './harness';
import { renderShellPrefix } from '../../../src/render.ts';

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

test('ambient exported API key is removed before installer and CLI subprocesses', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  const run = await runShellInstallerWithAmbientKey({ workspace: ws, configuration: claudeConfig(), baseUrl: modelServer.url });
  expect(run.code, `ambient key must be removed before child processes:\n${run.combined}`).toBe(0);
  expect(existsSync(installerMarker(ws))).toBeTruthy();
});

// --- PowerShell -------------------------------------------------------------

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
