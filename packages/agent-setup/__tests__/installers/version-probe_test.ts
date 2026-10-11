import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { SETUP_SCRIPT_BODIES } from '../../src/script-assets.ts';

const hasPowerShell = spawnSync('pwsh', ['--version']).status === 0;
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

test.each(['pi', 'omp'] as const)('Bash %s preserves failed version probe diagnostics', agent => {
  const directory = mkdtempSync(join(process.cwd(), '.version-probe-test-'));
  try {
    const executable = join(directory, agent);
    writeFileSync(executable, '#!/bin/sh\necho "upstream version probe failure" >&2\nexit 73\n');
    chmodSync(executable, 0o700);
    const body = SETUP_SCRIPT_BODIES[agent].sh;
    const script = `${body.slice(0, body.lastIndexOf("\nmain '"))}\nSETUP_TMPDIR=${quote(directory)}; ${agent.toUpperCase()}_BIN=${quote(executable)}; out_error() { echo "$*" >&2; }; ${agent}_write_version; exit $?;`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('upstream version probe failure');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(!hasPowerShell).each(['pi', 'omp'] as const)('PowerShell %s preserves failed version probe diagnostics', agent => {
  const directory = mkdtempSync(join(process.cwd(), '.version-probe-test-'));
  try {
    const executable = join(directory, agent);
    writeFileSync(executable, '#!/bin/sh\necho "upstream version probe failure" >&2\nexit 73\n');
    chmodSync(executable, 0o700);
    const body = SETUP_SCRIPT_BODIES[agent].ps1;
    const scriptPath = join(directory, 'probe.ps1');
    writeFileSync(scriptPath, `$ErrorActionPreference='Stop'\n${body.slice(0, body.lastIndexOf('$global:LASTEXITCODE = Main '))}\nfunction Stop-Setup { param([string]$Message); throw $Message };\n${agent === 'pi' ? '$global:PiBin=$args[0]; Write-PiVersion' : 'Test-SetupOmpVersion -Exe $args[0]'}`);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptPath, executable], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('upstream version probe failure');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
