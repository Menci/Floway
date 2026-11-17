import { describe, expect, test } from 'vitest';

import { JsoncRefusalError, updateDefaultModel, updatePiSettings, updatePiAuth } from '../../../installers/node/jsonc-edit.mjs';

describe('jsonc-edit settings.json', () => {
  test.each(['/* Keep this comment */\r\n', '\uFEFF// Keep this comment\r\n'])('preserves existing trivia while initializing settings: %j', source => {
    const output = updateDefaultModel(source, 'model', 'floway');
    expect(output.startsWith(source)).toBe(true);
    expect(output).toContain('"defaultModel": "model"');
  });

  test('clearing the only managed property preserves unrelated comments', () => {
    const source = '{\n  // Keep this comment\n  "defaultProvider": "floway"\n}';
    expect(updateDefaultModel(source, null, 'floway')).toBe('{\n  // Keep this comment\n}');
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

  test('propagates the original syntax error from malformed string literals', () => {
    expect(() => updateDefaultModel('{"theme":"\\q"}', 'model', 'floway')).toThrow(SyntaxError);
    expect(() => updateDefaultModel('{"theme":"line\nbreak"}', 'model', 'floway')).toThrow(SyntaxError);
  });

  test('refuses duplicate "defaultProvider" in settings', () => {
    const src = '{\n  "defaultProvider": "a",\n  "defaultProvider": "b"\n}';
    expect(() => updateDefaultModel(src, 'gpt-4o', 'floway')).toThrow(JsoncRefusalError);
  });
});

describe('jsonc-edit Pi preferences', () => {
  const preferences = { modelId: null, provider: 'floway-work', thinkingLevel: null, retry: { enabled: null, maxRetries: null } } as const;

  test('unset preferences preserve existing agent-wide values byte for byte', () => {
    const src = '{\n  "defaultProvider": "other",\n  "defaultModel": "model",\n  "defaultThinkingLevel": "high",\n  "retry": { "enabled": false, "maxRetries": 7, "baseDelayMs": 5000 }\n}';
    expect(updatePiSettings(src, preferences)).toBe(src);
  });

  test('nested updates preserve JSONC comments, CRLF, BOM and unrelated retry keys', () => {
    const src = '\uFEFF{\r\n  // Model preference\r\n  "defaultThinkingLevel": "low",\r\n  "retry": {\r\n    // Preserve the timing policy\r\n    "baseDelayMs": 3000,\r\n    "enabled": true,\r\n    "maxRetries": 4,\r\n  },\r\n  "theme": "light",\r\n}\r\n';
    const output = updatePiSettings(src, { ...preferences, thinkingLevel: 'max', retry: { enabled: false, maxRetries: 0 } });
    expect(output).toBe(src.replace('"defaultThinkingLevel": "low"', '"defaultThinkingLevel": "max"').replace('"enabled": true', '"enabled": false').replace('"maxRetries": 4', '"maxRetries": 0'));
  });

  test('refuses invalid or duplicate retry configuration before mutation', () => {
    for (const src of ['{"retry":null}', '{"retry":"invalid"}', '{"retry":{},"retry":{}}', '{"retry":{"enabled":true,"enabled":false}}']) {
      expect(() => updatePiSettings(src, { ...preferences, retry: { enabled: true, maxRetries: null } })).toThrow(JsoncRefusalError);
    }
  });
});

describe('jsonc-edit CLI contract', () => {
  const cliScript = new URL('../../../installers/node/jsonc-edit.mjs', import.meta.url).pathname;

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

});

test('Pi auth updates only the selected provider and encodes literal config metacharacters', () => {
  const original = '{\r\n  "openai": {"type":"api_key","key":"!keep-command"},\r\n  "floway-home": {"type":"api_key","key":"home-key"}\r\n}';
  const result = updatePiAuth(original, 'floway-work', '!key$VALUE');
  expect(result).toContain('"openai": {"type":"api_key","key":"!keep-command"}');
  expect(JSON.parse(result)).toEqual({ openai: { type: 'api_key', key: '!keep-command' }, 'floway-home': { type: 'api_key', key: 'home-key' }, 'floway-work': { type: 'api_key', key: '$!key$$VALUE' } });
  const updated = updatePiAuth(result, 'floway-work', 'rotated');
  expect(JSON.parse(updated)['floway-work']).toEqual({ type: 'api_key', key: 'rotated' });
  for (const input of ['[]', 'null', 'invalid', '{"floway":{},"floway":{}}']) expect(() => updatePiAuth(input, 'floway', 'key')).toThrow();
});
