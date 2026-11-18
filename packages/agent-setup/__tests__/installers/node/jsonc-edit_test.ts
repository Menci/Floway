import { describe, expect, test } from 'vitest';

import { JsoncRefusalError, updateDefaultModel, updatePiSettings, updatePiAuth } from '../../../installers/node/jsonc-edit.mjs';

describe('jsonc-edit settings.json', () => {
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
});

describe('jsonc-edit Pi preferences', () => {
  const preferences = { modelId: null, provider: 'floway-work', thinkingLevel: null, retry: { enabled: null, maxRetries: null } } as const;

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

test('Pi auth updates only the selected provider and encodes literal config metacharacters', () => {
  const original = '{\r\n  "openai": {"type":"api_key","key":"!keep-command"},\r\n  "floway-home": {"type":"api_key","key":"home-key"}\r\n}';
  const result = updatePiAuth(original, 'floway-work', '!key$VALUE');
  expect(result).toContain('"openai": {"type":"api_key","key":"!keep-command"}');
  expect(JSON.parse(result)).toEqual({ openai: { type: 'api_key', key: '!keep-command' }, 'floway-home': { type: 'api_key', key: 'home-key' }, 'floway-work': { type: 'api_key', key: '$!key$$VALUE' } });
  const updated = updatePiAuth(result, 'floway-work', 'rotated');
  expect(JSON.parse(updated)['floway-work']).toEqual({ type: 'api_key', key: 'rotated' });
  for (const input of ['[]', 'null', 'invalid', '{"floway":{},"floway":{}}']) expect(() => updatePiAuth(input, 'floway', 'key')).toThrow();
});
