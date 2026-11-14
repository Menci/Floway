import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { expect, test } from 'vitest';

import { bothConfig, claudeConfig, codexBackupFiles, codexConfig, codexHomeFor, codexTokenPath, hostPwsh, makeWorkspace, modelServer, placeFakeClaude, placeFakeCodex, runPowerShellInstaller, runShellInstaller, settingsPathFor } from './harness';
import type { Workspace } from './harness';

// VT control sequences are stripped and CRLF normalized; each line is right-trimmed
// and trailing blank lines dropped. Interior blank lines remain part of the
// heading/status output contract.
const normalizeLines = (text: string): string =>
  stripVTControlCharacters(text).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
const normalizeWorkspace = (text: string, workspace: Workspace): string =>
  normalizeLines(text).replaceAll(workspace.root, '<workspace>');
const hasVTControlCharacters = (text: string): boolean => stripVTControlCharacters(text) !== text;

test('output normalization strips VT controls and preserves control-like text', { timeout: 180_000 }, () => {
  const decorated = [
    '\u001B[31mred\u001B[0m',
    '\u001B[2A\u001B[3Ccursor',
    '\u001B]8;;https://floway.dev\u0007link\u001B]8;;\u0007',
  ].join(' ');
  expect(normalizeLines(decorated), 'SGR, cursor CSI, and OSC hyperlink sequences are stripped').toBe('red cursor link');
  expect(hasVTControlCharacters(decorated)).toBeTruthy();

  const plain = 'literal [31m, [2A, and ]8;;https://floway.dev text';
  expect(normalizeLines(plain), 'control-like ordinary text is unchanged').toBe(plain);
  expect(!hasVTControlCharacters(plain)).toBeTruthy();
});

// A hermetic single-agent run needs the harness to fully control discovery. The
// Codex CLI is discovered at absolute paths the sandbox cannot hide, so a host
// with a system Codex would emit a legitimate "multiple installations" warning;
// Claude's absolute candidates are absent here, so the clean-stderr contract is
// asserted through the Claude phase and guarded against a stray global Claude.
const GLOBAL_CLAUDE_LOCATIONS = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
const globalClaudePresent = (): boolean => GLOBAL_CLAUDE_LOCATIONS.some(p => existsSync(p));

test('Bash and PowerShell emit an identical happy-path stdout line sequence', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const bashWs = makeWorkspace();
  placeFakeClaude(bashWs.binDir);
  placeFakeCodex(bashWs.binDir);
  const bash = await runShellInstaller({ workspace: bashWs, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'claude' });
  expect(bash.code, `Bash happy path should succeed:\n${bash.combined}`).toBe(0);

  modelServer.reset();
  const psWs = makeWorkspace();
  placeFakeClaude(psWs.binDir);
  placeFakeCodex(psWs.binDir);
  const ps = await runPowerShellInstaller({ workspace: psWs, baseUrl: modelServer.url, configuration: bothConfig(), agent: 'claude' });
  expect(ps.code, `PowerShell happy path should succeed:\n${ps.combined}`).toBe(0);

  expect(normalizeWorkspace(ps.stdout, psWs), 'the two installers must print the same stdout structure').toBe(normalizeWorkspace(bash.stdout, bashWs));
  expect(normalizeLines(bash.stdout), 'the header identifies the agent and endpoint').toContain('==> Agent Setup: Claude Code\nEndpoint:');
  expect(normalizeLines(bash.stdout), 'the header identifies the selected API key').toContain('\nAPI Key: Primary key\n');
  expect(normalizeLines(bash.stdout), 'the installation section is explicit').toContain('\n==> Installing: Claude Code\n');
  expect(normalizeLines(bash.stdout), 'an existing CLI is reported').toContain('\nClaude Code is already installed.\n');
  expect(normalizeLines(bash.stdout), 'the configuration section is explicit').toContain('\n==> Configuring: Claude Code\n');
  expect(normalizeLines(bash.stdout), 'the settings path is reported').toContain(`Written to \`${settingsPathFor(bashWs)}\`.`);
  expect(normalizeLines(bash.stdout), 'setup-owned sections do not insert blank separator lines').not.toContain('\n\n');
  expect(normalizeLines(bash.stdout).match(/^==> /gm)?.length, 'the output has exactly the header, installation, configuration, and completion notices').toBe(4);
  expect(normalizeLines(bash.stdout), 'the successful result is explicit').toContain('==> Completed Agent Setup: Claude Code');
  expect(normalizeLines(bash.stdout), 'a single-agent script has no redundant summary').not.toContain('Summary');
});

test('a fully successful run keeps stderr empty and emits no escape codes when captured', { timeout: 180_000 }, async ({ skip }) => {
  if (globalClaudePresent()) return skip(true, 'a system Claude Code is installed at a known location; discovery is not hermetic');
  const bashWs = makeWorkspace();
  placeFakeClaude(bashWs.binDir);
  const bash = await runShellInstaller({ workspace: bashWs, baseUrl: modelServer.url, configuration: claudeConfig() });
  expect(bash.code, `should succeed:\n${bash.combined}`).toBe(0);
  expect(bash.stderr.trim(), 'a clean Bash run writes nothing to stderr').toBe('');
  expect(!hasVTControlCharacters(bash.combined)).toBeTruthy();

  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  modelServer.reset();
  const psWs = makeWorkspace();
  placeFakeClaude(psWs.binDir);
  const ps = await runPowerShellInstaller({ workspace: psWs, baseUrl: modelServer.url, configuration: claudeConfig() });
  expect(ps.code, `should succeed:\n${ps.combined}`).toBe(0);
  expect(ps.stderr.trim(), 'a clean PowerShell run writes nothing to stderr').toBe('');
  expect(!hasVTControlCharacters(ps.combined)).toBeTruthy();
});

test('Bash styles agent notices while leaving metadata plain', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const forced = await runShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: claudeConfig(), forceColor: true });
  expect(forced.code, `forced-color run should succeed:\n${forced.combined}`).toBe(0);
  expect(forced.stdout, 'the setup title uses the notice style').toContain('[34m==>[0m [1mAgent Setup: Claude Code[0m');
  expect(forced.stdout, 'the Endpoint metadata remains visible').toContain('Endpoint: ');
  expect(forced.stdout, 'the API Key metadata remains visible').toContain('API Key: Primary key');
  expect(forced.stdout, 'the Endpoint label is not styled').not.toContain('[1mEndpoint:');
  expect(forced.stdout, 'the API Key label is not styled').not.toContain('[1mAPI Key:');
  expect(forced.stdout, 'the installation section uses the notice style').toContain('[34m==>[0m [1mInstalling: Claude Code[0m');
  expect(forced.stdout, 'the configuration section uses the notice style').toContain('[34m==>[0m [1mConfiguring: Claude Code[0m');
  expect(forced.stdout, 'the successful result uses the notice style').toContain('[34m==>[0m [1mCompleted Agent Setup: Claude Code[0m');
  expect(forced.stdout, 'success does not use green ANSI styling').not.toContain('[92m');
  expect(!hasVTControlCharacters(forced.stderr)).toBeTruthy();

  const suppressed = makeWorkspace();
  placeFakeClaude(suppressed.binDir);
  const noColor = await runShellInstaller({ workspace: suppressed, baseUrl: modelServer.url, configuration: claudeConfig(), forceColor: true, noColor: true });
  expect(noColor.code, `NO_COLOR run should succeed:\n${noColor.combined}`).toBe(0);
  expect(!hasVTControlCharacters(noColor.combined)).toBeTruthy();
  expect(noColor.stdout, 'the plain heading is still present without color').toContain('Claude Code');
});

test('Bash routes errors to stderr with a red label', { timeout: 180_000 }, async () => {
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), '{ invalid json');
  const run = await runShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: claudeConfig(),
    forceColor: true,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(run.stderr, 'the error label is painted red on stderr').toContain('[91mError:[0m ');
  expect(run.stderr, 'the error retains its diagnostic body').toContain('is not valid Claude settings; leaving it untouched.');
  expect(run.stdout, 'the error does not leak onto stdout').not.toContain('is not valid Claude settings');
});

test('PowerShell colors stderr under forced color, keeps stdout escape-free, and honors NO_COLOR', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  const configDir = join(ws.home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPathFor(ws), '{ invalid json');
  const forced = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: claudeConfig(),
    forceColor: true,
  });
  expect(forced.code !== 0).toBeTruthy();
  expect(!hasVTControlCharacters(forced.stdout)).toBeTruthy();
  expect(forced.stderr, 'stderr colors the primary error label').toContain('[91mError:[0m ');

  const suppressed = makeWorkspace();
  placeFakeClaude(suppressed.binDir);
  mkdirSync(join(suppressed.home, '.claude'), { recursive: true });
  writeFileSync(settingsPathFor(suppressed), '{ invalid json');
  const noColor = await runPowerShellInstaller({
    workspace: suppressed, baseUrl: modelServer.url, configuration: claudeConfig(),
    forceColor: true, noColor: true,
  });
  expect(noColor.code !== 0).toBeTruthy();
  expect(!hasVTControlCharacters(noColor.combined)).toBeTruthy();
  expect(noColor.stderr, 'the plain error is still on stderr').toContain('Error: ');
});

test('a multiple-installation warning is a stderr line on both installers', { timeout: 180_000 }, async ({ skip }) => {
  const bashWs = makeWorkspace();
  placeFakeClaude(bashWs.binDir);
  placeFakeClaude(join(bashWs.home, '.local/bin'));
  const bash = await runShellInstaller({ workspace: bashWs, baseUrl: modelServer.url, configuration: claudeConfig(), forceColor: true });
  expect(bash.code, `should succeed:\n${bash.combined}`).toBe(0);
  expect(bash.stderr, 'Bash colors only the warning label').toContain('[93mWarning:[0m multiple Claude Code installations detected;');
  expect(bash.stdout, 'the warning is not on stdout').not.toContain('multiple Claude Code installations detected');

  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  modelServer.reset();
  const psWs = makeWorkspace();
  placeFakeClaude(psWs.binDir);
  placeFakeClaude(join(psWs.home, '.local/bin'));
  const ps = await runPowerShellInstaller({ workspace: psWs, baseUrl: modelServer.url, configuration: claudeConfig(), forceColor: true });
  expect(ps.code, `should succeed:\n${ps.combined}`).toBe(0);
  expect(ps.stderr, 'PowerShell colors only the warning label').toContain('[93mWarning:[0m multiple Claude Code installations detected;');
  expect(ps.stdout, 'the warning is not on stdout').not.toContain('multiple Claude Code installations detected');
});

test('PowerShell surfaces one primary error without a double wrapper', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeClaude(ws.binDir);
  mkdirSync(join(ws.home, '.claude'), { recursive: true });
  writeFileSync(settingsPathFor(ws), '{ invalid json');
  const run = await runPowerShellInstaller({ workspace: ws, baseUrl: modelServer.url, configuration: claudeConfig() });
  expect(run.code !== 0).toBeTruthy();
  expect(run.combined, 'the removed double-wrapper phrasing must not return').not.toContain('setup failed');
  const errorCount = run.stderr.split('\n').filter(line => line.includes('is not valid JSON; leaving it untouched.')).length;
  expect(errorCount, 'the primary error is printed exactly once').toBe(1);
  expect(run.stdout, 'the error stays off stdout').not.toContain('is not valid JSON');
});

test('PowerShell rollback restore failure preserves the Codex provider-token backup', { timeout: 180_000 }, async ({ skip }) => {
  if (!hostPwsh) return skip(true, 'no PowerShell interpreter on this host');
  const ws = makeWorkspace();
  placeFakeCodex(ws.binDir);
  const home = codexHomeFor(ws);
  mkdirSync(home, { recursive: true });
  writeFileSync(codexTokenPath(ws), 'old-provider-token');
  const run = await runPowerShellInstaller({
    workspace: ws, baseUrl: modelServer.url, configuration: codexConfig(),
    fakeCodexAppServerMode: 'error', failRestore: true,
  });
  expect(run.code !== 0).toBeTruthy();
  expect(run.stderr, 'a rollback-failure warning is printed to stderr').toContain('Warning: could not restore');
  expect(run.stderr, 'the warning names the preserved provider token').toContain('provider token');
  expect(run.stderr, 'the warning names the manual action').toContain('restore it by hand');
  const backups = codexBackupFiles(home, 'floway-token');
  expect(backups.length, 'the provider-token backup is preserved for manual recovery').toBe(1);
});
