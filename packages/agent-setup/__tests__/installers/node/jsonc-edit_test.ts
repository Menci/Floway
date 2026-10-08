import { describe, expect, test } from 'vitest';

import { JsoncRefusalError, updateDefaultModel, updatePiSettings } from '../../../installers/node/jsonc-edit.mjs';

describe('jsonc-edit settings.json', () => {
  test('creates fresh settings.json on empty input when model is specified', () => {
    const out = updateDefaultModel('', 'gpt-4o', 'floway');
    expect(JSON.parse(out)).toEqual({ defaultProvider: 'floway', defaultModel: 'gpt-4o' });
  });

  test('creates empty object on empty input when model is null', () => {
    const out = updateDefaultModel('', null, 'floway');
    expect(JSON.parse(out)).toEqual({});
  });

  test.each(['// Keep this comment', '/* Keep this comment */\r\n', '\uFEFF// Keep this comment\r\n', '  \n'])('preserves existing trivia while initializing settings: %j', source => {
    const output = updateDefaultModel(source, 'model', 'floway');
    expect(output.startsWith(source)).toBe(true);
    expect(output).toContain('"defaultModel": "model"');
  });

  test('clearing the only managed property preserves unrelated comments', () => {
    const source = '{\n  // Keep this comment\n  "defaultProvider": "floway"\n}';
    expect(updateDefaultModel(source, null, 'floway')).toBe('{\n  // Keep this comment\n}');
  });

  test('sets defaultProvider and defaultModel into existing settings', () => {
    const src = `{
  // User setting
  "theme": "dark",
  "steeringMode": "all"
}`;
    const out = updateDefaultModel(src, 'claude-3-7-sonnet', 'floway');
    expect(out).toContain('"theme": "dark"');
    expect(out).toContain('"steeringMode": "all"');
    expect(out).toContain('"defaultProvider": "floway"');
    expect(out).toContain('"defaultModel": "claude-3-7-sonnet"');
  });

  test('updates existing defaultProvider and defaultModel', () => {
    const src = `{
  "defaultProvider": "other-provider",
  "defaultModel": "other-model",
  "other": 123
}`;
    const out = updateDefaultModel(src, 'new-model', 'floway');
    expect(out).toContain('"defaultProvider": "floway"');
    expect(out).toContain('"defaultModel": "new-model"');
    expect(out).toContain('"other": 123');
  });

  test('removes defaultProvider and defaultModel when model is null and provider is floway', () => {
    const src = `{
  // User comment
  "defaultProvider": "floway",
  "defaultModel": "gpt-4o",
  "keepMe": true
}`;
    const out = updateDefaultModel(src, null, 'floway');
    expect(out).not.toContain('"defaultProvider"');
    expect(out).not.toContain('"defaultModel"');
    expect(out).toContain('// User comment');
    expect(out).toContain('"keepMe": true');
  });

  test('keeps defaultProvider and defaultModel when model is null and provider is NOT floway', () => {
    const src = `{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-3-5-sonnet",
  "keepMe": true
}`;
    const out = updateDefaultModel(src, null, 'floway');
    expect(out).toBe(src);
  });

  test('sets and clears the exact selected provider while preserving another Floway instance', () => {
    const original = '{\n  // Keep this preference\n  "defaultProvider": "floway-home",\n  "defaultModel": "home-model",\n  "theme": "light"\n}';
    expect(updateDefaultModel(original, null, 'floway-work')).toBe(original);
    const selected = updateDefaultModel(original, 'work-model', 'floway-work');
    expect(selected).toContain('// Keep this preference');
    expect(JSON.parse(selected.replace('// Keep this preference', ''))).toEqual({ defaultProvider: 'floway-work', defaultModel: 'work-model', theme: 'light' });
    const cleared = updateDefaultModel(selected, null, 'floway-work');
    expect(cleared).toContain('"theme": "light"');
    expect(cleared).not.toContain('defaultProvider');
    expect(cleared).not.toContain('defaultModel');
  });

  test('serializes the provider as data when updating an existing default', () => {
    const provider = 'instance"\\\n';
    const out = updateDefaultModel('{"defaultProvider":"old","defaultModel":"old"}', 'model', provider);
    expect(JSON.parse(out)).toEqual({ defaultProvider: provider, defaultModel: 'model' });
  });

  test('idempotency: applying default model twice produces identical output', () => {
    const src = '{\n  "theme": "light"\n}';
    const first = updateDefaultModel(src, 'gpt-4o', 'floway');
    const second = updateDefaultModel(first, 'gpt-4o', 'floway');
    expect(second).toBe(first);
  });

  describe('safe refusals', () => {
    test('refuses duplicate "defaultProvider" in settings', () => {
      const src = '{\n  "defaultProvider": "a",\n  "defaultProvider": "b"\n}';
      expect(() => updateDefaultModel(src, 'gpt-4o', 'floway')).toThrow(JsoncRefusalError);
    });

    test('refuses duplicate "defaultModel" in settings', () => {
      const src = '{\n  "defaultModel": "a",\n  "defaultModel": "b"\n}';
      expect(() => updateDefaultModel(src, 'gpt-4o', 'floway')).toThrow(JsoncRefusalError);
    });

    test('refuses root that is not an object', () => {
      expect(() => updateDefaultModel('[]', 'gpt-4o', 'floway')).toThrow(JsoncRefusalError);
    });
  });
});

describe('jsonc-edit Pi preferences', () => {
  const preferences = { modelId: null, provider: 'floway-work', thinkingLevel: null, retry: { enabled: null, maxRetries: null } } as const;

  test('unset preferences preserve existing agent-wide values byte for byte', () => {
    const src = '{\n  "defaultProvider": "other",\n  "defaultModel": "model",\n  "defaultThinkingLevel": "high",\n  "retry": { "enabled": false, "maxRetries": 7, "baseDelayMs": 5000 }\n}';
    expect(updatePiSettings(src, preferences)).toBe(src);
  });

  test('creates thinking and retry preferences without selecting a default model', () => {
    const output = updatePiSettings('', { ...preferences, thinkingLevel: 'high', retry: { enabled: false, maxRetries: 0 } });
    expect(JSON.parse(output)).toEqual({ defaultThinkingLevel: 'high', retry: { enabled: false, maxRetries: 0 } });
  });

  test('nested updates preserve JSONC comments, CRLF, BOM and unrelated retry keys', () => {
    const src = '\uFEFF{\r\n  // Model preference\r\n  "defaultThinkingLevel": "low",\r\n  "retry": {\r\n    // Preserve the timing policy\r\n    "baseDelayMs": 3000,\r\n    "enabled": true,\r\n    "maxRetries": 4,\r\n  },\r\n  "theme": "light",\r\n}\r\n';
    const output = updatePiSettings(src, { ...preferences, thinkingLevel: 'max', retry: { enabled: false, maxRetries: 0 } });
    expect(output).toBe(src.replace('"defaultThinkingLevel": "low"', '"defaultThinkingLevel": "max"').replace('"enabled": true', '"enabled": false').replace('"maxRetries": 4', '"maxRetries": 0'));
  });

  test('adds a preference inside an inline retry object without escaping its boundary', () => {
    const src = '{"retry":{"baseDelayMs":3500},"theme":"light"}';
    const output = updatePiSettings(src, { ...preferences, retry: { enabled: false, maxRetries: 0 } });
    expect(JSON.parse(output)).toEqual({ retry: { baseDelayMs: 3500, enabled: false, maxRetries: 0 }, theme: 'light' });
  });

  test('retains comments in an otherwise empty retry object', () => {
    const src = '{\n  "retry": {\n    // This is deliberate\n  },\n  "theme": "light"\n}';
    const output = updatePiSettings(src, { ...preferences, retry: { enabled: true, maxRetries: null } });
    expect(output).toContain('// This is deliberate');
    expect(output).toContain('"enabled": true');
    expect(output).toContain('"theme": "light"');
  });

  test('refuses invalid or duplicate retry configuration before mutation', () => {
    for (const src of ['{"retry":null}', '{"retry":"invalid"}', '{"retry":{},"retry":{}}', '{"retry":{"enabled":true,"enabled":false}}']) {
      expect(() => updatePiSettings(src, { ...preferences, retry: { enabled: true, maxRetries: null } })).toThrow(JsoncRefusalError);
    }
  });
});

describe('jsonc-edit CLI contract', () => {
  const cliScript = new URL('../../../installers/node/jsonc-edit.mjs', import.meta.url).pathname;

  test('edits settings.json via stdin and stdout with FLOWAY_DEFAULT_MODEL', async () => {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.execPath, [cliScript, 'settings'], {
      input: '{\n  "theme": "dark"\n}\n',
      env: { ...process.env, FLOWAY_DEFAULT_PROVIDER: 'floway', FLOWAY_DEFAULT_MODEL: 'claude-3-7-sonnet' },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"defaultProvider": "floway"');
    expect(res.stdout).toContain('"defaultModel": "claude-3-7-sonnet"');
    expect(res.stderr).toBe('');
  });

  test('CLI writes false and zero retry preferences without applying defaults to omitted values', async () => {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, [cliScript, 'settings'], {
      input: '{"defaultThinkingLevel":"low","retry":{"baseDelayMs":3500}}',
      env: { ...process.env, FLOWAY_DEFAULT_PROVIDER: 'floway-work', FLOWAY_PI_THINKING_LEVEL: '', FLOWAY_PI_RETRY_ENABLED: 'false', FLOWAY_PI_MAX_RETRIES: '0' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ defaultThinkingLevel: 'low', retry: { baseDelayMs: 3500, enabled: false, maxRetries: 0 } });
  });

  test('exits with status 2 and writes error to stderr on refusal', async () => {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.execPath, [cliScript, 'settings'], {
      input: 'invalid_json{',
      env: { ...process.env, FLOWAY_DEFAULT_PROVIDER: 'floway', FLOWAY_DEFAULT_MODEL: 'gpt-4o' },
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Refusal:');
  });

  test('runs the CLI from a path that is percent-encoded in its file URL', async () => {
    const { mkdtempSync, copyFileSync, mkdirSync, symlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawn } = await import('node:child_process');
    const dir = join(mkdtempSync(join(tmpdir(), 'jsonc edit ')), 'sub dir');
    mkdirSync(dir);
    const copied = join(dir, 'jsonc-edit.mjs');
    copyFileSync(cliScript, copied);
    const linked = join(dir, 'linked.mjs');
    symlinkSync(copied, linked);

    for (const script of [copied, linked]) {
      const out = await new Promise<{ code: number | null; stdout: string }>(resolve => {
        const child = spawn(process.execPath, [script, 'settings'], {
          env: { ...process.env, FLOWAY_DEFAULT_PROVIDER: 'floway', FLOWAY_DEFAULT_MODEL: 'gpt-4o' },
        });
        let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.on('close', code => resolve({ code, stdout }));
        child.stdin.end('');
      });
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout).defaultModel).toBe('gpt-4o');
    }
  });
});
