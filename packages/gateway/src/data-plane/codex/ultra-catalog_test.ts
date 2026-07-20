import { describe, expect, test } from 'vitest';

import type { CatalogModel } from './catalog.ts';
import { applyCodexUltraCatalogSupport, isCodexClient } from './ultra-catalog.ts';

const base = (slug = 'gpt-5.6-sol'): CatalogModel => ({
  slug,
  supported_reasoning_levels: [
    { effort: 'low', description: 'Low' },
    { effort: 'max', description: 'Max' },
  ],
  multi_agent_version: 'v1',
});

describe('Codex Ultra catalog support', () => {
  test.each([
    ['Codex Desktop/0.145.0-alpha.18 (Windows 10.0.28000; x86_64) unknown', true],
    ['codex_exec/0.143.9 (test)', true],
    ['codex_cli_rs/0.144.1 (test)', true],
    ['MY-CODEX-PROXY', true],
    ['curl/8.0', false],
    ['', false],
    [undefined, false],
  ] as const)('detects the Codex product marker in %s', (userAgent, supported) => {
    expect(isCodexClient(userAgent)).toBe(supported);
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

  test('leaves non-GPT models unchanged even when they support Max', () => {
    const model = base('claude-opus-4.7');
    expect(applyCodexUltraCatalogSupport(model, { enabled: true })).toBe(model);
  });

  test('leaves GPT models unchanged when they do not support Max', () => {
    const model: CatalogModel = {
      ...base(),
      supported_reasoning_levels: [{ effort: 'high', description: 'High' }],
    };
    expect(applyCodexUltraCatalogSupport(model, { enabled: true })).toBe(model);
  });

  test('recognizes a prefixed GPT model with a variant suffix', () => {
    const model = base('openrouter/gpt-5.6-sol:nitro');
    const result = applyCodexUltraCatalogSupport(model, { enabled: true });
    expect(result.supported_reasoning_levels).toContainEqual(expect.objectContaining({ effort: 'ultra' }));
  });

  test('uses the final public-id segment instead of a GPT-looking provider prefix', () => {
    const model = base('gpt-provider/claude-opus-4.7');
    expect(applyCodexUltraCatalogSupport(model, { enabled: true })).toBe(model);
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
