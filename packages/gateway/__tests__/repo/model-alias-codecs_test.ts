import { describe, expect, test } from 'vitest';

import { decodeAliasTargets, decodeAnnouncedMetadata } from '../../src/repo/model-alias-codecs.ts';
import { MODEL_ALIAS_TARGET_LIMIT } from '../../src/shared/model-aliases.ts';

describe('stored model alias targets', () => {
  test.each([
    { targets: [] },
    { targets: [{ target_model_id: '', rules: {} }] },
    { targets: [{ target_model_id: 'model', rules: { reasoning: { effort: '' } } }] },
    { targets: [{ target_model_id: 'model', rules: { reasoning: { summary: '' } } }] },
    { targets: [{ target_model_id: 'model', rules: { reasoning: { budget_tokens: -1 } } }] },
    { targets: [{ target_model_id: 'model', rules: { reasoning: { budget_tokens: 1.5 } } }] },
    { targets: [{ target_model_id: 'model', rules: { reasoning: { adaptive: true, budget_tokens: 0 } } }] },
    { targets: [{ target_model_id: 'model', rules: { verbosity: '' } }] },
    { targets: [{ target_model_id: 'model', rules: { serviceTier: '' } }] },
  ])('rejects state the control-plane write boundary cannot produce: $targets', ({ targets }) => {
    expect(() => decodeAliasTargets(JSON.stringify(targets), 'alias_corrupt')).toThrow(
      'model_aliases.targets JSON is invalid for id=alias_corrupt',
    );
  });

  test('preserves future properties while validating current fields', () => {
    const targets = JSON.parse('[{"target_model_id":"model","rules":{"reasoning":{"adaptive":false,"budget_tokens":0,"futureReasoning":7},"futureRule":{"__proto__":{"safe":true}}},"futureTarget":true}]');

    expect(decodeAliasTargets(JSON.stringify(targets), 'alias_future')).toEqual(targets);
  });

  test('rejects a corrupt target list beyond the request-time work limit', () => {
    const targets = Array.from(
      { length: MODEL_ALIAS_TARGET_LIMIT + 1 },
      (_, index) => ({ target_model_id: `model-${index}`, rules: {} }),
    );
    expect(() => decodeAliasTargets(JSON.stringify(targets), 'alias_oversized')).toThrow(
      'model_aliases.targets JSON is invalid for id=alias_oversized',
    );
  });
});

describe('stored model alias announced metadata', () => {
  test.each([
    { chat: { modalities: { input: [], output: ['text'] } } },
    { chat: { modalities: { input: ['image'], output: ['text'] } } },
    { chat: { modalities: { input: ['text'], output: [] } } },
    { chat: { modalities: { input: ['text', 'text'], output: ['text'] } } },
    { chat: { reasoning: {} } },
    { chat: { reasoning: { adaptive: false } } },
    { chat: { reasoning: { mandatory: false } } },
    { chat: { reasoning: { effort: { supported: [], default: 'low' } } } },
    { chat: { reasoning: { effort: { supported: ['low'], default: 'high' } } } },
    { chat: { reasoning: { budget_tokens: { min: -1 } } } },
    { chat: { reasoning: { budget_tokens: { min: 10, max: 9 } } } },
  ])('rejects invalid current metadata: %j', metadata => {
    expect(() => decodeAnnouncedMetadata(JSON.stringify(metadata), 'alias_corrupt')).toThrow(
      'model_aliases.announced_metadata_json JSON is invalid for id=alias_corrupt',
    );
  });

  test('preserves unknown metadata at every extensible object boundary', () => {
    const metadata = JSON.parse('{"limits":{"max_output_tokens":1024,"futureLimit":7},"chat":{"reasoning":{"adaptive":true,"futureReasoning":8},"futureChat":9},"futureMetadata":{"__proto__":{"safe":true}}}');

    expect(decodeAnnouncedMetadata(JSON.stringify(metadata), 'alias_future')).toEqual(metadata);
  });
});
