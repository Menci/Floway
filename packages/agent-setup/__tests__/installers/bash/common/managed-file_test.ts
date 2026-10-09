import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const secret = 'SYNTHETIC_PRIVATE_KEY_MARKER';
const connection = { provider: 'personal', endpoint: 'https://personal.example/prefix', apiKey: `${secret}'"\\\n\u2028\u2029\u0024()\u0060` };
const priorWork = { provider: 'work', endpoint: 'https://old.example', apiKey: 'old-key' };
const nextWork = { provider: 'work', endpoint: 'https://new.example', apiKey: 'new"quoted\\key' };
const source = (connections: unknown): string => JSON.stringify({ connections });
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const available = (command: string): boolean => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0;

for (const platform of ['bash', 'powershell'] as const) {
  for (const includeKey of [true, false]) {
    const enabled = platform === 'bash' ? available('bash') && available('jq') : available('pwsh');
    describe.skipIf(!enabled)(`${platform} provider configuration merge (stored key: ${includeKey})`, () => {
      const entry = (value: typeof connection) => includeKey ? value : { provider: value.provider, endpoint: value.endpoint };
      const run = (existingSource: string, verify: (result: ReturnType<typeof spawnSync>, stageSource: string) => void): void => {
        const directory = mkdtempSync(join(packageRoot, '.provider-config-merge-'));
        try {
          const existing = join(directory, 'existing.json');
          const stage = join(directory, 'stage.json');
          writeFileSync(existing, existingSource);
          writeFileSync(stage, source([entry(nextWork)]));
          const command = platform === 'bash'
            ? [
                'JQ=jq; ensure_jq() { return 0; }; out_error() { printf "%s\\n" "$*" >&2; };',
                `SETUP_TMPDIR=${shellQuote(directory)}; SETUP_ENDPOINT=${shellQuote(nextWork.endpoint)}; SETUP_API_KEY=${shellQuote(nextWork.apiKey)};`,
                `source ${shellQuote(join(packageRoot, 'installers/bash/common/managed-file.sh'))};`,
                `_stage_provider_connections ${shellQuote(existing)} ${shellQuote(stage)} work ${includeKey}`,
              ].join('\n')
            : [
                "$ErrorActionPreference = 'Stop'",
                'function Stop-Setup { param([string]$Message) throw $Message }',
                'function Test-SetupIsWindows { return [System.Environment]::OSVersion.Platform -eq "Win32NT" }',
                `. ${psQuote(join(packageRoot, 'installers/powershell/common/managed-file.ps1'))}`,
                `$SetupEndpoint=${psQuote(nextWork.endpoint)}; $SetupApiKey=${psQuote(nextWork.apiKey)};`,
                `Stage-SetupProviderConnections -ExistingPath ${psQuote(existing)} -StagePath ${psQuote(stage)} -Provider work -IncludeKey $${includeKey}`,
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

      test('replaces only the named provider and preserves opaque credentials', () => {
        run(source([entry(connection), entry(priorWork)]), (result, staged) => {
          expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
          expect(JSON.parse(staged).connections).toEqual([entry(connection), entry(nextWork)]);
        });
      });

      test('initializes an empty connection list', () => {
        run(source([]), (result, staged) => {
          expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
          expect(JSON.parse(staged).connections).toEqual([entry(nextWork)]);
        });
      });

      test('rejects malformed installed JSON without printing credentials', () => {
        run(`{"connections":[{"apiKey":"${secret}","endpoint":INVALID}]}`, result => {
          expect(result.status).not.toBe(0);
          expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
        });
      });

      test.each([{}, { connections: null }, { connections: {} }, { connections: secret }])('rejects non-array connections without printing credentials: %j', value => {
        run(JSON.stringify(value), result => {
          expect(result.status).not.toBe(0);
          expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
        });
      });

      test('rejects an empty installed connection file', () => {
        run('', result => { expect(result.status).not.toBe(0); });
      });
    });
  }
}
