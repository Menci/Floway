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
    const run = (source: string | null, enabled: string, maxRetries: string, model = '') => {
      const directory = mkdtempSync(join(packageRoot, '.omp-config-'));
      try {
        const configPath = join(directory, 'config.yml');
        if (source !== null) writeFileSync(configPath, source);
        const body = readFileSync(join(packageRoot, `installers/${platform}/omp.${platform === 'bash' ? 'sh' : 'ps1'}`), 'utf8');
        const script = platform === 'bash'
          ? [
              'JQ=jq; set -u; out_error() { printf "%s\\n" "$*" >&2; };',
              body.slice(0, body.lastIndexOf("main 'oh-my-pi'")),
              `OMP_CONFIG_PATH=${shellQuote(configPath)}; SETUP_OMP_PROVIDER=work; SETUP_OMP_MODEL=${shellQuote(model)};`,
              `SETUP_OMP_RETRY_ENABLED=${shellQuote(enabled)}; SETUP_OMP_MAX_RETRIES=${shellQuote(maxRetries)};`,
              'omp_stage_config || exit $?;',
              `if [ -n "$OMP_CONFIG_STAGE" ]; then cp "$OMP_CONFIG_STAGE" ${shellQuote(join(directory, 'result.yml'))}; fi`,
            ].join('\n')
          : [
              "$ErrorActionPreference='Stop'; function Stop-Setup { param([string]$Message) throw $Message }; function Protect-SetupFile { param([string]$Path) };",
              body.slice(0, body.lastIndexOf("$global:LASTEXITCODE = Main 'oh-my-pi'")),
              `$script:OmpConfigPath=${psQuote(configPath)}; $SetupOmpProvider='work'; $SetupOmpModel=${psQuote(model)};`,
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

    test.each(['TRUE', 'null', ''])('overwrites an old retry leaf using the explicit new typed value: %s', scalar => {
      const source = `retry:\n  enabled:${scalar ? ` ${scalar}` : ''} # enabled\n  maxRetries: +3 # attempts\n`;
      const result = run(source, 'false', '0');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe('retry:\n  enabled: false # enabled\n  maxRetries: 0 # attempts\n');
    });

    test('preserves case-sensitive retry keys while adding canonical settings', () => {
      const source = 'retry:\n  Enabled: true\n  MaxRetries: 3\n';
      const result = run(source, 'false', '0');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe(`${source}  enabled: false\n  maxRetries: 0\n`);
    });

    test('preserves an unrelated quoted retry mapping with different casing', () => {
      const source = '"Retry":\n  enabled: true\n';
      const result = run(source, 'false', '');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe(`${source}retry:\n  enabled: false\n`);
    });

    test('preserves case-sensitive role keys while selecting the canonical default', () => {
      const source = 'modelRoles:\n  Default: other/model\n  "DEFAULT": other/quoted\n';
      const result = run(source, '', '', 'chosen');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe(`${source}  default: "work/chosen"\n`);
    });

    test('preserves an unrelated quoted role mapping with different casing', () => {
      const source = '"ModelRoles":\n  default: other/model\n';
      const result = run(source, '', '', 'chosen');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe(`${source}modelRoles:\n  default: "work/chosen"\n`);
    });

    test('omitted settings preserve existing retry values and another connection default byte for byte', () => {
      const source = "# Model preferences\r\nmodelRoles:\r\n  default: 'personal/alias'\r\nretry:\r\n  enabled: false\r\n  maxRetries: 3";
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

    test('replaces an explicit default while preserving BOM, indentation, comments and other roles', () => {
      const source = '\uFEFF# Preferences\r\nmodelRoles: # startup\r\n    default: other/model # keep\r\n    plan: other/plan\r\ntheme: custom';
      const result = run(source, '', '', 'chosen');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe(source.replace('other/model', '"work/chosen"'));
    });

    test.each(['work/alias', "'work/alias'", '"work/alias"'])('clears only the selected provider scalar and preserves comments: %s', scalar => {
      const source = `modelRoles: # roles\n  default: ${scalar} # keep\n  plan: other/plan\n`;
      const result = run(source, '', '');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe('modelRoles: # roles\n   # keep\n  plan: other/plan\n');
    });

    test.each(['other', 'work'])('keeps YAML model suffixes opaque when clearing defaults: %s', provider => {
      const source = `modelRoles:\n  default: "${provider}/alias\\e"\n  plan: other/a&b # * policy\n`;
      const result = run(source, '', '');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe(provider === 'work' ? 'modelRoles:\n  plan: other/a&b # * policy\n' : source);
    });

    test('preserves quoted key text inside unrelated retry comments', () => {
      const source = 'retry:\n  maxDelayMs: 3500 # "enabled": policy\n';
      const result = run(source, 'false', '');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe(`${source}  enabled: false\n`);
    });

    test('removes an empty role mapping without removing unrelated comments', () => {
      const result = run('# Preferences\nmodelRoles: # roles\n  default: work/alias # keep\n', '', '');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe('# Preferences\n # roles\n   # keep\n');
    });

    test('serializes opaque model IDs as one YAML-compatible JSON scalar', () => {
      const model = 'quote\'"\\\n#&*中文\t\u007f';
      const result = run(null, '', '', model);
      expect(result.status, result.output).toBe(0);
      const scalar = result.staged!.split('\n')[1]!.slice('  default: '.length);
      expect(JSON.parse(scalar)).toBe(`work/${model}`);
      expect(run(result.staged, '', '').staged).toBe('');
    });

    test('preserves tabs in comments when updating a scalar', () => {
      const source = '# Comment\tformat\nmodelRoles:\n  default: other/model\n';
      const result = run(source, '', '', 'chosen');
      expect(result.status, result.output).toBe(0);
      expect(result.staged).toBe(source.replace('other/model', '"work/chosen"'));
    });

    test.each([
      'retry: { enabled: true }\n',
      'retry: &shared\n  enabled: true\n',
      'retry:\n  enabled: true\nretry:\n  enabled: false\n',
      'retry:\n  enabled: true\n  enabled: false\n',
      'retry:\n  enabled: [true]\n',
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
        'set +e; JQ=jq; main() { :; }; out_error() { echo "$*" >&2; };',
        `source ${shellQuote(join(packageRoot, 'installers/bash/omp.sh'))};`,
        `OMP_CONFIG_PATH=${shellQuote(config)}; SETUP_OMP_PROVIDER=floway; SETUP_OMP_MODEL=model; SETUP_OMP_RETRY_ENABLED=; SETUP_OMP_MAX_RETRIES=;`,
        failure === 'serialization'
          ? [
              'writes=0; printf() { writes=$((writes + 1)); if [ "$writes" -eq 2 ]; then echo "test serialization failure" >&2; return 73; fi; builtin printf "$@"; };',
              'omp_stage_config; exit $?;',
            ].join('\n')
          : [
              `OMP_EXTENSION_STAGE=${shellQuote(join(directory, 'extension-stage'))}; OMP_EXTENSION_PATH=${shellQuote(join(directory, 'extension.js'))};`,
              `OMP_PLUGIN_SETTINGS_PATH=${shellQuote(join(directory, 'omp-plugins.lock.json'))}; OMP_PLUGIN_SETTINGS_STAGE=${shellQuote(join(directory, 'connections-stage'))};`,
              `OMP_MANIFEST_STAGE=${shellQuote(join(directory, 'manifest-stage'))}; OMP_MANIFEST_PATH=${shellQuote(join(directory, 'package.json'))};`,
              ': > "$OMP_MANIFEST_STAGE"; : > "$OMP_PLUGIN_SETTINGS_STAGE"; : > "$OMP_EXTENSION_STAGE"; OMP_CONFIG_STAGE="$OMP_CONFIG_PATH.stage"; : > "$OMP_CONFIG_STAGE";',
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

const hasPowerShell = spawnSync('pwsh', ['--version'], { encoding: 'utf8' }).status === 0;
test.skipIf(!hasPowerShell)('PowerShell OMP propagates empty-config deletion failure', () => {
  const directory = mkdtempSync(join(packageRoot, '.omp-delete-failure-'));
  try {
    const config = join(directory, 'config.yml');
    const extension = join(directory, 'floway.js');
    const extensionStage = join(directory, 'extension-stage');
    const configStage = join(directory, 'config-stage');
    writeFileSync(config, 'modelRoles:\n  default: work/alias\n');
    writeFileSync(extensionStage, 'new extension');
    writeFileSync(configStage, '');
    const connectionsStage = join(directory, 'connections-stage');
    writeFileSync(connectionsStage, '{"plugins":{},"settings":{"@floway-dev/omp":{"connections":[]}}}');
    const manifestStage = join(directory, 'manifest-stage');
    writeFileSync(manifestStage, '{}');
    const body = readFileSync(join(packageRoot, 'installers/powershell/omp.ps1'), 'utf8');
    const script = [
      "$ErrorActionPreference='Stop'; function Test-SetupIsWindows { $false }; function Protect-SetupFile { param([string]$Path) };",
      body.slice(0, body.lastIndexOf("$global:LASTEXITCODE = Main 'oh-my-pi'")),
      '$script:OmpPluginSettingsExisted=$false; $script:OmpExtensionExisted=$false; $script:OmpManifestExisted=$false;',
      `$script:OmpPluginSettingsStage=${psQuote(connectionsStage)}; $script:OmpPluginSettingsPath=${psQuote(join(directory, 'omp-plugins.lock.json'))};`,
      `$script:OmpManifestStage=${psQuote(manifestStage)}; $script:OmpManifestPath=${psQuote(join(directory, 'package.json'))};`,
      `$script:OmpExtensionStage=${psQuote(extensionStage)}; $script:OmpExtensionPath=${psQuote(extension)};`,
      `$script:OmpConfigStage=${psQuote(configStage)}; $script:OmpConfigPath=${psQuote(config)};`,
      `function Remove-Item { param([string]$LiteralPath, [switch]$Force, [string]$ErrorAction); if ($LiteralPath -eq ${psQuote(config)}) { throw 'test deletion failure' }; Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop };`,
      'Apply-SetupOmpStaged;',
    ].join('\n');
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('test deletion failure');
    expect(readFileSync(config, 'utf8')).toBe('modelRoles:\n  default: work/alias\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Bash OMP protects a reused config stage before writing existing settings', () => {
  const directory = mkdtempSync(join(packageRoot, '.omp-stage-protection-test-'));
  try {
    const config = join(directory, 'config.yml');
    const source = 'other: private-setting\n';
    writeFileSync(config, source);
    const script = [
      'set +e; JQ=jq; main() { :; }; out_error() { echo "$*" >&2; };',
      `source ${shellQuote(join(packageRoot, 'installers/bash/omp.sh'))};`,
      `OMP_CONFIG_PATH=${shellQuote(config)}; SETUP_OMP_PROVIDER=floway; SETUP_OMP_MODEL=; SETUP_OMP_RETRY_ENABLED=; SETUP_OMP_MAX_RETRIES=;`,
      'reused="$OMP_CONFIG_PATH.floway-stage.$$"; : > "$reused"; chmod 644 "$reused";',
      `printf() { mode=$(${shellQuote(process.execPath)} -e 'process.stdout.write((require("node:fs").statSync(process.argv[1]).mode & 511).toString(8))' "$OMP_CONFIG_STAGE"); if [ "$mode" != 600 ]; then echo "unprotected stage mode $mode before write" >&2; return 73; fi; builtin printf "$@"; };`,
      'omp_stage_config || exit $?; cat "$OMP_CONFIG_STAGE";',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toBe(source);
    expect(readFileSync(config, 'utf8')).toBe(source);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
