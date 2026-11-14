import { describe, expect, it } from 'vitest';

import { limitKeysForKind, pruneLimitsForKind } from '../../../src/components/models/limits';
import { MODEL_KINDS } from '@floway-dev/protocols/browser';

describe('model limit fields by kind', () => {
  // Every kind is listed so a new one cannot silently inherit a shape. Only a
  // chat turn has an output side to split a window with, so only chat states
  // the prompt/output pair; an image model has no token window at all.
  it('states the prompt/output split for chat alone', () => {
    expect(limitKeysForKind('chat')).toEqual(['max_context_window_tokens', 'max_prompt_tokens', 'max_output_tokens']);
    for (const kind of ['embedding', 'rerank', 'transcription', 'decision'] as const) {
      expect(limitKeysForKind(kind)).toEqual(['max_context_window_tokens']);
    }
    expect(limitKeysForKind('image')).toEqual([]);
  });

  it('covers every kind in the vocabulary', () => {
    for (const kind of MODEL_KINDS) expect(limitKeysForKind(kind)).toBeDefined();
  });

  it('drops the limits a kind cannot state', () => {
    const limits = { max_context_window_tokens: 1_000_000, max_prompt_tokens: 872_000, max_output_tokens: 128_000 };
    expect(pruneLimitsForKind(limits, 'chat')).toEqual(limits);
    expect(pruneLimitsForKind(limits, 'decision')).toEqual({ max_context_window_tokens: 1_000_000 });
    expect(pruneLimitsForKind(limits, 'image')).toBeUndefined();
  });

  it('keeps an absent limit absent rather than materializing a default', () => {
    expect(pruneLimitsForKind(undefined, 'chat')).toBeUndefined();
    expect(pruneLimitsForKind({}, 'chat')).toBeUndefined();
    expect(pruneLimitsForKind({ max_output_tokens: 128_000 }, 'decision')).toBeUndefined();
  });
});
