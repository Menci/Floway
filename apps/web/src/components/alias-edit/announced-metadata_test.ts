import { describe, expect, it } from 'vitest';

import { computeAnnouncedMetadata } from './announced-metadata.ts';
import { buildRealModel } from '../../api/test-fixtures.ts';
import type { AliasTarget, ChatAliasRules, ControlPlaneModel } from '../../api/types.ts';

// Mirror of `packages/gateway/src/data-plane/shared/listing/alias_test.ts`'s
// matrix on the frontend's hand-written `intersectChat` / `intersectLimits`.
// The two have already drifted once (the ||→&& fix landed gateway-side first),
// so every invariant the gateway test pins lands here too.

const target = (id: string, rules: ChatAliasRules = {}): AliasTarget => ({ target_model_id: id, rules });

const real = (id: string, over: Partial<ControlPlaneModel> = {}): ControlPlaneModel =>
  buildRealModel({ id, ...over });

describe('computeAnnouncedMetadata', () => {
  it('returns {} when no target resolves against the live catalog', () => {
    const result = computeAnnouncedMetadata([target('gone')], 'chat', [real('other')]);
    expect(result).toEqual({});
  });

  it('intersects modalities across all available targets', () => {
    const result = computeAnnouncedMetadata(
      [target('a'), target('b')],
      'chat',
      [
        real('a', { chat: { modalities: { input: ['text', 'image'], output: ['text'] } } }),
        real('b', { chat: { modalities: { input: ['text'], output: ['text'] } } }),
      ],
    );
    expect(result.chat?.modalities).toEqual({ input: ['text'], output: ['text'] });
  });

  it('omits the modalities block when either half of the intersection collapses', () => {
    const result = computeAnnouncedMetadata(
      [target('a'), target('b')],
      'chat',
      [
        real('a', { chat: { modalities: { input: ['text'], output: ['text'] } } }),
        real('b', { chat: { modalities: { input: ['text'], output: ['image'] } } }),
      ],
    );
    expect(result.chat?.modalities).toBeUndefined();
  });

  it('intersects effort supported across targets', () => {
    const result = computeAnnouncedMetadata(
      [target('a'), target('b')],
      'chat',
      [
        real('a', { chat: { reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } } } }),
        real('b', { chat: { reasoning: { effort: { supported: ['low', 'medium'], default: 'low' } } } }),
      ],
    );
    expect(result.chat?.reasoning?.effort?.supported).toEqual(['low', 'medium']);
  });

  it('drops the budget_tokens block when one target declares only min and another only max', () => {
    const result = computeAnnouncedMetadata(
      [target('a'), target('b')],
      'chat',
      [
        real('a', { chat: { reasoning: { budget_tokens: { min: 1024 } } } }),
        real('b', { chat: { reasoning: { budget_tokens: { max: 65536 } } } }),
      ],
    );
    expect(result.chat?.reasoning?.budget_tokens).toBeUndefined();
  });

  it('takes min across max_context_window_tokens / max_output_tokens / max_prompt_tokens', () => {
    const result = computeAnnouncedMetadata(
      [target('a'), target('b')],
      'chat',
      [
        real('a', { limits: { max_context_window_tokens: 200000, max_output_tokens: 8192 } }),
        real('b', { limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 } }),
      ],
    );
    expect(result.limits).toEqual({ max_context_window_tokens: 128000, max_output_tokens: 4096 });
  });

  it('omits a limits leaf when any target leaves it undeclared', () => {
    const result = computeAnnouncedMetadata(
      [target('a'), target('b')],
      'chat',
      [
        real('a', { limits: { max_context_window_tokens: 200000 } }),
        real('b', { limits: {} }),
      ],
    );
    expect(result.limits?.max_context_window_tokens).toBeUndefined();
  });

  it('drops a sub-field downgraded by a pinned rule (effort: alias fixes the value, so it is not advertised)', () => {
    const result = computeAnnouncedMetadata(
      [target('a', { reasoning: { effort: 'low' } })],
      'chat',
      [real('a', { chat: { reasoning: { effort: { supported: ['low', 'medium'], default: 'medium' } } } })],
    );
    expect(result.chat?.reasoning).toBeUndefined();
  });
});
