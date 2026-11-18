import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { expect, test } from 'vitest';

import { bothConfig, claudeConfig, hostPwsh, makeWorkspace, modelServer, placeFakeClaude, placeFakeCodex, runPowerShellInstaller, runShellInstaller, settingsPathFor } from './harness';
import type { Workspace } from './harness';

// VT control sequences are stripped and CRLF normalized; each line is right-trimmed
// and trailing blank lines dropped. Interior blank lines remain part of the
// heading/status output contract.
const normalizeLines = (text: string): string =>
  stripVTControlCharacters(text).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
const normalizeWorkspace = (text: string, workspace: Workspace): string =>
  normalizeLines(text).replaceAll(workspace.root, '<workspace>');

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
