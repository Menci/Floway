import { describe, expect, test } from 'vitest';

import { JsoncRefusalError, upsertFlowayProvider, updateDefaultModel } from '../installers/node/jsonc-edit.mjs';

const sampleProvider = {
  name: 'Floway',
  baseUrl: 'https://gateway.example/v1',
  apiKey: 'sk-test-secret',
  api: 'openai-responses',
  models: [
    { id: 'm1', name: 'Model 1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ],
};

describe('jsonc-edit models.json', () => {
  test('creates fresh models.json on empty input', () => {
    const out = upsertFlowayProvider('', sampleProvider);
    expect(JSON.parse(out)).toEqual({ providers: { floway: sampleProvider } });
  });

  test('creates fresh models.json on whitespace-only input', () => {
    const out = upsertFlowayProvider('   \n  \t  ', sampleProvider);
    expect(JSON.parse(out)).toEqual({ providers: { floway: sampleProvider } });
  });

  test('preserves UTF-8 BOM', () => {
    const src = '\uFEFF{\n  "providers": {}\n}\n';
    const out = upsertFlowayProvider(src, sampleProvider);
    expect(out.startsWith('\uFEFF')).toBe(true);
    expect(JSON.parse(out.slice(1))).toEqual({ providers: { floway: sampleProvider } });
  });

  test('preserves CRLF line endings', () => {
    const src = '{\r\n  "providers": {}\r\n}\r\n';
    const out = upsertFlowayProvider(src, sampleProvider);
    expect(out).toContain('\r\n');
    expect(out).not.toMatch(/[^\r]\n/);
    expect(JSON.parse(out)).toEqual({ providers: { floway: sampleProvider } });
  });

  test('preserves comments containing //, /*, quotes and braces', () => {
    const src = `{
  // line comment with /* block */ and "quoted" and {braces}
  /* block comment with // nested
     and "more quotes" and {more braces} */
  "providers": {
    // comment before other provider
    "ollama": {
      "baseUrl": "http://localhost:11434"
    } // inline comment after other provider
  }
}
`;
    const out = upsertFlowayProvider(src, sampleProvider);
    expect(out).toContain('// line comment with /* block */ and "quoted" and {braces}');
    expect(out).toContain('/* block comment with // nested\n     and "more quotes" and {more braces} */');
    expect(out).toContain('// comment before other provider');
    expect(out).toContain('// inline comment after other provider');
    expect(out).toContain('"ollama": {\n      "baseUrl": "http://localhost:11434"\n    }');
    expect(out).toContain('"floway": {');
  });

  test('preserves strings containing // and braces', () => {
    const src = `{
  "providers": {
    "custom": {
      "name": "Provider // not a comment {also braces} /* not comment */",
      "baseUrl": "https://example.com/api//v1/{slot}"
    }
  }
}`;
    const out = upsertFlowayProvider(src, sampleProvider);
    expect(out).toContain('"name": "Provider // not a comment {also braces} /* not comment */"');
    expect(out).toContain('"baseUrl": "https://example.com/api//v1/{slot}"');
    expect(out).toContain('"floway": {');
  });

  test('preserves trailing commas and comments', () => {
    const src = `{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434",
    }, // trailing comma comment
  },
}
`;
    const out = upsertFlowayProvider(src, sampleProvider);
    expect(out).toContain('}, // trailing comma comment');
    expect(out).toContain('"floway": {');
  });

  test('handles root with no "providers" key', () => {
    const src = '{\n  "customSetting": true\n}\n';
    const out = upsertFlowayProvider(src, sampleProvider);
    expect(out).toContain('"customSetting": true');
    expect(out).toContain('"providers": {');
    expect(out).toContain('"floway": {');
  });

  test('handles empty "providers" object', () => {
    const src = '{\n  "providers": {}\n}\n';
    const out = upsertFlowayProvider(src, sampleProvider);
    expect(out).toContain('"floway": {');
    expect(JSON.parse(out)).toEqual({ providers: { floway: sampleProvider } });
  });

  test('replaces existing "floway" provider in place without moving other providers', () => {
    const src = `{
  "providers": {
    "alpha": { "baseUrl": "http://alpha" },
    // comment above floway
    "floway": {
      "name": "Old Floway",
      "baseUrl": "http://old-floway",
      "apiKey": "old-key"
    },
    // comment below floway
    "omega": { "baseUrl": "http://omega" }
  }
}`;
    const out = upsertFlowayProvider(src, sampleProvider);
    expect(out).toContain('// comment above floway');
    expect(out).toContain('// comment below floway');
    expect(out).toContain('"alpha": { "baseUrl": "http://alpha" }');
    expect(out).toContain('"omega": { "baseUrl": "http://omega" }');
    expect(out).not.toContain('"Old Floway"');
    expect(out).toContain('"https://gateway.example/v1"');
    // Ensure alpha is still before floway and omega is still after floway
    const alphaIdx = out.indexOf('"alpha"');
    const flowayIdx = out.indexOf('"floway"');
    const omegaIdx = out.indexOf('"omega"');
    expect(alphaIdx).toBeLessThan(flowayIdx);
    expect(flowayIdx).toBeLessThan(omegaIdx);
  });

  test('other providers untouched byte for byte', () => {
    const src = `{
  "providers": {
    "exact": {
      "arbitrary-whitespace":    "   spaced   "   ,
      "nested": [1,  2, /*comment*/ 3  ]
    }
  }
}`;
    const out = upsertFlowayProvider(src, sampleProvider);
    expect(out).toContain('"arbitrary-whitespace":    "   spaced   "   ,');
    expect(out).toContain('"nested": [1,  2, /*comment*/ 3  ]');
  });

  test('idempotency: running twice produces identical result', () => {
    const src = `{
  // Top comment
  "providers": {
    "existing": { "id": 123 }
  }
}`;
    const first = upsertFlowayProvider(src, sampleProvider);
    const second = upsertFlowayProvider(first, sampleProvider);
    expect(second).toBe(first);
  });

  describe('safe refusals', () => {
    test('refuses root that is not an object (array)', () => {
      expect(() => upsertFlowayProvider('[]', sampleProvider)).toThrow(JsoncRefusalError);
    });

    test('refuses root that is a string', () => {
      expect(() => upsertFlowayProvider('"not an object"', sampleProvider)).toThrow(JsoncRefusalError);
    });

    test('refuses unclosed block comment', () => {
      expect(() => upsertFlowayProvider('{ /* unclosed', sampleProvider)).toThrow(JsoncRefusalError);
    });

    test('refuses unclosed string literal', () => {
      expect(() => upsertFlowayProvider('{ "unclosed: 1 }', sampleProvider)).toThrow(JsoncRefusalError);
    });

    test('refuses unbalanced braces', () => {
      expect(() => upsertFlowayProvider('{ "providers": { "foo": 1 }', sampleProvider)).toThrow(JsoncRefusalError);
    });

    test('refuses duplicate "providers" key in root', () => {
      const src = '{\n  "providers": {},\n  "providers": {}\n}';
      expect(() => upsertFlowayProvider(src, sampleProvider)).toThrow(JsoncRefusalError);
    });

    test('refuses "providers" when not an object', () => {
      const src = '{\n  "providers": "invalid"\n}';
      expect(() => upsertFlowayProvider(src, sampleProvider)).toThrow(JsoncRefusalError);
    });

    test('refuses duplicate "floway" key in providers', () => {
      const src = '{\n  "providers": {\n    "floway": {},\n    "floway": {}\n  }\n}';
      expect(() => upsertFlowayProvider(src, sampleProvider)).toThrow(JsoncRefusalError);
    });

    test('refuses existing "floway" provider when not an object', () => {
      const src = '{\n  "providers": {\n    "floway": "string-provider"\n  }\n}';
      expect(() => upsertFlowayProvider(src, sampleProvider)).toThrow(JsoncRefusalError);
    });

    test('refuses trailing unexpected content after root', () => {
      const src = '{} trailing_garbage';
      expect(() => upsertFlowayProvider(src, sampleProvider)).toThrow(JsoncRefusalError);
    });
  });
});

describe('jsonc-edit settings.json', () => {
  test('creates fresh settings.json on empty input when model is specified', () => {
    const out = updateDefaultModel('', 'gpt-4o');
    expect(JSON.parse(out)).toEqual({ defaultProvider: 'floway', defaultModel: 'gpt-4o' });
  });

  test('creates empty object on empty input when model is null', () => {
    const out = updateDefaultModel('', null);
    expect(JSON.parse(out)).toEqual({});
  });

  test('sets defaultProvider and defaultModel into existing settings', () => {
    const src = `{
  // User setting
  "theme": "dark",
  "steeringMode": "all"
}`;
    const out = updateDefaultModel(src, 'claude-3-7-sonnet');
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
    const out = updateDefaultModel(src, 'new-model');
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
    const out = updateDefaultModel(src, null);
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
    const out = updateDefaultModel(src, null);
    expect(out).toBe(src);
  });

  test('idempotency: applying default model twice produces identical output', () => {
    const src = '{\n  "theme": "light"\n}';
    const first = updateDefaultModel(src, 'gpt-4o');
    const second = updateDefaultModel(first, 'gpt-4o');
    expect(second).toBe(first);
  });

  describe('safe refusals', () => {
    test('refuses duplicate "defaultProvider" in settings', () => {
      const src = '{\n  "defaultProvider": "a",\n  "defaultProvider": "b"\n}';
      expect(() => updateDefaultModel(src, 'gpt-4o')).toThrow(JsoncRefusalError);
    });

    test('refuses duplicate "defaultModel" in settings', () => {
      const src = '{\n  "defaultModel": "a",\n  "defaultModel": "b"\n}';
      expect(() => updateDefaultModel(src, 'gpt-4o')).toThrow(JsoncRefusalError);
    });

    test('refuses root that is not an object', () => {
      expect(() => updateDefaultModel('[]', 'gpt-4o')).toThrow(JsoncRefusalError);
    });
  });
});

describe('jsonc-edit CLI contract', () => {
  const cliScript = new URL('../installers/node/jsonc-edit.mjs', import.meta.url).pathname;

  test('edits models.json via stdin and stdout with FLOWAY_PROVIDER_JSON', async () => {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.execPath, [cliScript, 'models'], {
      input: '{\n  "providers": {}\n}\n',
      env: { ...process.env, FLOWAY_PROVIDER_JSON: JSON.stringify(sampleProvider) },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ providers: { floway: sampleProvider } });
    expect(res.stderr).toBe('');
  });

  test('edits settings.json via stdin and stdout with FLOWAY_DEFAULT_MODEL', async () => {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.execPath, [cliScript, 'settings'], {
      input: '{\n  "theme": "dark"\n}\n',
      env: { ...process.env, FLOWAY_DEFAULT_MODEL: 'claude-3-7-sonnet' },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"defaultProvider": "floway"');
    expect(res.stdout).toContain('"defaultModel": "claude-3-7-sonnet"');
    expect(res.stderr).toBe('');
  });

  test('exits with status 2 and writes error to stderr on refusal', async () => {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.execPath, [cliScript, 'models'], {
      input: 'invalid_json{',
      env: { ...process.env, FLOWAY_PROVIDER_JSON: JSON.stringify(sampleProvider) },
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Refusal:');
  });

  // Regression: the CLI guard once compared import.meta.url with
  // `file://${argv[1]}`, which never matches on Windows (file:///C:/ vs C:\)
  // or for a path with spaces (percent-encoded). runCli() was then skipped and
  // the process exited 0 with empty stdout, so the installer wrote empty files.
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
        const child = spawn(process.execPath, [script, 'models'], {
          env: { ...process.env, FLOWAY_PROVIDER_JSON: JSON.stringify(sampleProvider) },
        });
        let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.on('close', code => resolve({ code, stdout }));
        child.stdin.end('');
      });
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout).providers.floway.api).toBe('openai-responses');
    }
  });
});
