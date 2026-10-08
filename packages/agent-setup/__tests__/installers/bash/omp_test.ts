import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

for (const platform of ['bash', 'powershell'] as const) {
  const command = platform === 'bash' ? 'bash' : 'pwsh';
  const available = spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0;
  describe.skipIf(!available)(`${platform} OMP staged retry settings`, () => {
    const run = (source: string | null, enabled: string, maxRetries: string) => {
      const directory = mkdtempSync(join(packageRoot, '.omp-config-'));
      try {
        const configPath = join(directory, 'config.yml');
        if (source !== null) writeFileSync(configPath, source);
        const body = readFileSync(join(packageRoot, `installers/${platform}/omp.${platform === 'bash' ? 'sh' : 'ps1'}`), 'utf8');
        const script = platform === 'bash'
          ? [
              'out_error() { printf "%s\\n" "$*" >&2; };',
              body.slice(0, body.lastIndexOf("main 'oh-my-pi'")),
              `OMP_CONFIG_PATH=${shellQuote(configPath)}; SETUP_OMP_PROVIDER=work; SETUP_OMP_MODEL='';`,
              `SETUP_OMP_RETRY_ENABLED=${shellQuote(enabled)}; SETUP_OMP_MAX_RETRIES=${shellQuote(maxRetries)};`,
              'omp_stage_config || exit $?;',
              `if [ -n "$OMP_CONFIG_STAGE" ]; then cp "$OMP_CONFIG_STAGE" ${shellQuote(join(directory, 'result.yml'))}; fi`,
            ].join('\n')
          : [
              "$ErrorActionPreference='Stop'; function Stop-Setup { param([string]$Message) throw $Message }; function Protect-SetupFile { param([string]$Path) };",
              body.slice(0, body.lastIndexOf("$global:LASTEXITCODE = Main 'oh-my-pi'")),
              `$script:OmpConfigPath=${psQuote(configPath)}; $SetupOmpProvider='work'; $SetupOmpModel='';`,
              `$SetupOmpRetryEnabled=${enabled === '' ? '$null' : enabled === 'true' ? '$true' : '$false'}; $SetupOmpMaxRetries=${psQuote(maxRetries)};`,
              'Stage-SetupOmpConfig;',
              `if ($script:OmpConfigStage) { Copy-Item -LiteralPath $script:OmpConfigStage -Destination ${psQuote(join(directory, 'result.yml'))} };`,
            ].join('\n');
        const result = spawnSync(command, platform === 'bash' ? ['-c', script] : ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 10000 });
        expect(existsSync(configPath) ? readFileSync(configPath, 'utf8') : null).toBe(source);
        const staged = existsSync(join(directory, 'result.yml')) ? readFileSync(join(directory, 'result.yml'), 'utf8') : null;
        return { status: result.status, output: `${result.stdout}${result.stderr}`, staged };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    };

    test('updates explicit values while preserving comments, unrelated fields, indentation and CRLF without a trailing newline', () => {
      const source = '# Preferences\r\nretry: # policy\r\n    enabled: true  # network\r\n    maxRetries: 10 # attempts\r\n    maxDelayMs: 300000\r\n    modelFallback: false\r\ntheme: custom';
      const result = run(source, 'false', '0');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe(source.replace('enabled: true', 'enabled: false').replace('maxRetries: 10', 'maxRetries: 0'));
    });

    test('omitted settings preserve existing retry values and another connection default byte for byte', () => {
      const source = "# floway:begin\r\nmodelRoles:\r\n  default: 'personal/alias'\r\n# floway:end\r\nretry:\r\n  enabled: false\r\n  maxRetries: 3";
      const result = run(source, '', '');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe(source);
    });

    test('creates retry settings even without a model or an existing configuration', () => {
      const result = run(null, 'true', '7');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe('retry:\n  enabled: true\n  maxRetries: 7\n');
    });

    test('appends a new retry mapping while preserving an existing missing trailing newline', () => {
      const result = run('# Preferences\r\ntheme: custom', 'false', '');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe('# Preferences\r\ntheme: custom\r\nretry:\r\n  enabled: false');
    });

    test('preserves trailing scalar whitespace', () => {
      const result = run('retry:\n  enabled: true  \n', 'false', '');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe('retry:\n  enabled: false  \n');
    });

    test('inserts a missing key without replacing an omitted key or the following mapping', () => {
      const result = run('retry:\n  enabled: false # keep\ntheme: custom\n', '', '4');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe('retry:\n  enabled: false # keep\n  maxRetries: 4\ntheme: custom\n');
    });

    test.each([
      'retry: { enabled: true }\n',
      'retry: &shared\n  enabled: true\n',
      'retry:\n  enabled: true\nretry:\n  enabled: false\n',
      'retry:\n  enabled: true\n  enabled: false\n',
      'retry:\n  enabled: definitely\n',
      '"retry":\n  enabled: true\n',
      'retry:\n  "enabled": true\n',
    ])('rejects ambiguous or invalid managed values without touching the original: %s', source => {
      const result = run(source, 'false', '');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/cannot be edited safely|must be a single/);
      expect(result.output).not.toContain('ParserError');
      expect(result.staged).toBe(null);
    });
  });
}

for (const failure of ['serialization', 'deletion'] as const) {
  test(`OMP propagates ${failure} failure before reporting successful configuration`, () => {
    const directory = mkdtempSync(join(packageRoot, '.omp-write-failure-'));
    try {
      const config = join(directory, 'config.yml');
      writeFileSync(config, 'unrelated: preserved\n');
      const script = [
        'set +e; main() { :; }; out_error() { echo "$*" >&2; };',
        `source ${shellQuote(join(packageRoot, 'installers/bash/omp.sh'))};`,
        `OMP_CONFIG_PATH=${shellQuote(config)}; SETUP_OMP_PROVIDER=floway; SETUP_OMP_MODEL=model; SETUP_OMP_RETRY_ENABLED=; SETUP_OMP_MAX_RETRIES=;`,
        failure === 'serialization'
          ? [
              'writes=0; printf() { writes=$((writes + 1)); if [ "$writes" -eq 2 ]; then echo "test serialization failure" >&2; return 73; fi; builtin printf "$@"; };',
              'omp_stage_config; exit $?;',
            ].join('\n')
          : [
              `OMP_EXTENSION_STAGE=${shellQuote(join(directory, 'extension-stage'))}; OMP_EXTENSION_PATH=${shellQuote(join(directory, 'extension.js'))};`,
              ': > "$OMP_EXTENSION_STAGE"; OMP_CONFIG_STAGE="$OMP_CONFIG_PATH.stage"; : > "$OMP_CONFIG_STAGE";',
              'rm() { echo "test deletion failure" >&2; return 73; };',
              'omp_apply_staged; exit $?;',
            ].join('\n'),
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000 });
      expect(result.status).toBe(73);
      expect(result.stderr).toContain(`test ${failure} failure`);
      expect(readFileSync(config, 'utf8')).toBe('unrelated: preserved\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
