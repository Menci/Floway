import { describe, expect, test } from 'vitest';

import { toPublicModel } from './load.ts';
import type { InternalModel } from '@floway-dev/provider';

const base: InternalModel = {
  id: 'm1',
  kind: 'chat',
  limits: { max_context_window_tokens: 100000 },
  endpoints: { chatCompletions: {} },
  providerModels: {},
};

describe('toPublicModel', () => {
  test('omits chat when not set', () => {
    expect(toPublicModel(base).chat).toBeUndefined();
  });

  test('propagates chat metadata verbatim', () => {
    const chat = {
      modalities: { input: ['text', 'image'] as const, output: ['text'] as const },
      reasoning: { effort: { supported: ['low', 'high'] as const, default: 'low' } },
    };
    expect(toPublicModel({ ...base, chat }).chat).toEqual(chat);
  });

  test('stamps the upstream endpoint map onto the wire entry verbatim', () => {
    expect(toPublicModel(base).endpoints).toEqual({ chatCompletions: {} });
  });
});

// The alias merge step inside `loadModels` (alias entries follow real
// entries, alias names winning id collisions) is exercised through the
// integration suite in `serve_test.ts` so the assertion observes the same
// `/v1/models` payload a real client would see.
