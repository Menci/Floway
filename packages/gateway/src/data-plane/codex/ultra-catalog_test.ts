import { describe, expect, test } from 'vitest';

import type { CatalogModel } from './catalog.ts';
import { applyCodexUltraCatalogSupport, codexClientSupportsUltra } from './ultra-catalog.ts';

const base = (): CatalogModel => ({
  slug: 'model-a',
  supported_reasoning_levels: [
    { effort: 'low', description: 'Low' },
    { effort: 'max', description: 'Max' },
  ],
  multi_agent_version: 'v1',
});

describe('Codex Ultra catalog support', () => {
  test.each([
    ['codex_exec/0.143.9 (test)', false],
    ['codex_exec/0.144.0-rc.1 (test)', false],
    ['codex_exec/0.144.0 (test)', true],
    ['codex_cli_rs/0.144.1 (test)', true],
    ['codex_cli_rs/1.0.0-test (test)', true],
    ['curl/8.0', false],
    [undefined, false],
  ] as const)('detects client support from %s', (userAgent, supported) => {
    expect(codexClientSupportsUltra(userAgent)).toBe(supported);
  });

  test('returns the original model when disabled', () => {
    const model = base();
    expect(applyCodexUltraCatalogSupport(model, { enabled: false })).toBe(model);
  });

  test('adds Ultra and enables multi-agent v2 without mutating the source', () => {
    const model = base();
    const result = applyCodexUltraCatalogSupport(model, { enabled: true });

    expect(result).not.toBe(model);
    expect(result.multi_agent_version).toBe('v2');
    expect(result.supported_reasoning_levels).toEqual([
      { effort: 'low', description: 'Low' },
      { effort: 'max', description: 'Max' },
      { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
    ]);
    expect(model).toEqual(base());
  });

  test('does not duplicate an existing Ultra entry', () => {
    const model: CatalogModel = {
      ...base(),
      supported_reasoning_levels: [
        { effort: 'max', description: 'Max' },
        { effort: 'ultra', description: 'Upstream Ultra' },
      ],
    };
    const result = applyCodexUltraCatalogSupport(model, { enabled: true });
    expect(result.supported_reasoning_levels).toEqual(model.supported_reasoning_levels);
    expect(result.multi_agent_version).toBe('v2');
  });
});
