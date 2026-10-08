import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const marker = '// Managed by Floway Agent Setup.';
const secret = 'SYNTHETIC_PRIVATE_KEY_MARKER';
const connection = { provider: 'personal', endpoint: 'https://personal.example/prefix', apiKey: `${secret}'"\\\n\u2028\u2029\u0024()\u0060` };
const priorWork = { provider: 'work', endpoint: 'https://old.example', apiKey: 'old-key' };
const nextWork = { provider: 'work', endpoint: 'https://new.example', apiKey: 'new"quoted\\key' };
const body = 'export default async pi => {};\n';
const source = (connections: unknown): string => `${marker}\nconst connections = ${JSON.stringify(connections)};\n${body}`;
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const available = (command: string): boolean => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0;

for (const platform of ['bash', 'powershell'] as const) {
  const enabled = platform === 'bash' ? available('bash') && available('jq') : available('pwsh');
  describe.skipIf(!enabled)(`${platform} provider extension merge`, () => {
    const run = (existingSource: string, verify: (result: ReturnType<typeof spawnSync>, stageSource: string) => void): void => {
      const directory = mkdtempSync(join(packageRoot, '.provider-extension-merge-'));
      try {
        const existing = join(directory, 'existing.js');
        const stage = join(directory, 'stage.js');
        writeFileSync(existing, existingSource);
        writeFileSync(stage, source([nextWork]));
        const command = platform === 'bash'
          ? [
              'JQ=jq; ensure_jq() { return 0; }; out_error() { printf "%s\\n" "$*" >&2; };',
              `SETUP_TMPDIR=${shellQuote(directory)};`,
              `source ${shellQuote(join(packageRoot, 'installers/bash/common/managed-file.sh'))};`,
              `_merge_provider_extension ${shellQuote(existing)} ${shellQuote(stage)}`,
            ].join('\n')
          : [
              'function Stop-Setup { param([string]$Message) throw $Message }',
              'function Test-SetupIsWindows { return [System.Environment]::OSVersion.Platform -eq "Win32NT" }',
              `. ${psQuote(join(packageRoot, 'installers/powershell/common/managed-file.ps1'))}`,
              `Merge-SetupProviderExtension -ExistingPath ${psQuote(existing)} -StagePath ${psQuote(stage)}`,
            ].join('\n');
        const result = spawnSync(platform === 'bash' ? 'bash' : 'pwsh', platform === 'bash' ? ['-c', command] : ['-NoProfile', '-Command', command], {
          encoding: 'utf8', timeout: 10000,
        });
        verify(result, readFileSync(stage, 'utf8'));
        expect(readFileSync(existing, 'utf8')).toBe(existingSource);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    };

    test('replaces only the named provider and preserves opaque credentials and the new runtime body', () => {
      run(source([connection, priorWork]), (result, staged) => {
        expect(result.status).toBe(0);
        expect(`${result.stdout}${result.stderr}`).toBe('');
        expect(staged.split('\n')[0]).toBe(marker);
        const literal = staged.split('\n')[1]!;
        const connections = JSON.parse(literal.slice('const connections = '.length, -1));
        expect(connections).toEqual([connection, nextWork]);
        expect(staged.endsWith(body)).toBe(true);
      });
    });

    test('rejects an empty installed configuration before replacing the stage', () => {
      run(source([]), (result, staged) => {
        expect(result.status).not.toBe(0);
        expect(staged).toBe(source([nextWork]));
      });
    });

    test('rejects a missing connection header without discarding installed providers', () => {
      const missing = `${marker}\nconst unrelated = [];\n${body}`;
      run(missing, (result, staged) => {
        expect(result.status).not.toBe(0);
        expect(staged).toBe(source([nextWork]));
      });
    });

    test('rejects malformed installed JSON without printing credentials', () => {
      const malformed = `${marker}\nconst connections = [{"provider":"personal","apiKey":"${secret}","endpoint":INVALID}];\n${body}`;
      run(malformed, (result, staged) => {
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
        expect(staged).toBe(source([nextWork]));
      });
    });
  });
}
