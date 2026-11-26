import { expect, test } from 'vitest';

import {
  decodeUpstreamModel,
  encodeUpstreamModel,
} from '../../src/repo/upstream-codecs.ts';
import type { ProviderModel } from '@floway-dev/provider';

test('stored model codec round-trips a decision target and enabledFlags Set', () => {
  const model: ProviderModel = {
    id: 'decision-1',
    upstreamModelId: 'decision-1',
    kind: 'decision',
    limits: {},
    endpoints: { decision: {} },
    opaqueBlobCompatibilityScope: { bindToUpstream: true },
    enabledFlags: new Set(['vendor-kimi'] as const),
    decisionTarget: { protocol: 'typesafe-systemone', path: '/providers/microsoft/v1/systemone' },
  };
  expect(decodeUpstreamModel(encodeUpstreamModel(model), 'up_azure')).toEqual(model);
});

test('encodeUpstreamModel is byte-deterministic across property/Set orders and preserves own __proto__ keys', () => {
  const protoDataA = Object.fromEntries([
    ['__proto__', { nestedZ: 1, nestedA: 2 }],
    ['omitted', undefined],
    ['zeta', true],
    ['alpha', 42],
  ]);
  const protoDataB = Object.fromEntries([
    ['alpha', 42],
    ['zeta', true],
    ['__proto__', { nestedA: 2, nestedZ: 1 }],
  ]);

  const modelA: ProviderModel = {
    id: 'gpt-5',
    upstreamModelId: 'gpt-5-wire',
    kind: 'chat',
    limits: { max_output_tokens: 16_384, max_context_window_tokens: 128_000 },
    endpoints: { openaiResponses: {}, openaiChatCompletions: {} },
    chat: {
      modalities: { output: ['text'], input: ['text', 'image'] },
      reasoning: { effort: { default: 'medium', supported: ['low', 'medium', 'high'] } },
    },
    opaqueBlobCompatibilityScope: { key: 'shared', bindToUpstream: false },
    enabledFlags: new Set(['vendor-kimi', 'vendor-deepseek', 'serialize-stream-items'] as const),
    providerData: protoDataA,
  };

  const modelB: ProviderModel = {
    providerData: protoDataB,
    enabledFlags: new Set(['serialize-stream-items', 'vendor-deepseek', 'vendor-kimi'] as const),
    opaqueBlobCompatibilityScope: { bindToUpstream: false, key: 'shared' },
    chat: {
      reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
      modalities: { input: ['text', 'image'], output: ['text'] },
    },
    endpoints: { openaiChatCompletions: {}, openaiResponses: {} },
    limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_384 },
    kind: 'chat',
    upstreamModelId: 'gpt-5-wire',
    id: 'gpt-5',
  };

  const encodedA = encodeUpstreamModel(modelA);
  const encodedB = encodeUpstreamModel(modelB);
  expect(encodedA).toBe(encodedB);

  const decoded = decodeUpstreamModel(encodedA, 'up_test');
  expect(decoded.enabledFlags).toEqual(new Set(['serialize-stream-items', 'vendor-deepseek', 'vendor-kimi']));
  const providerData = decoded.providerData as Record<string, unknown>;
  expect(Object.hasOwn(providerData, '__proto__')).toBe(true);
  expect(providerData['__proto__']).toEqual({ nestedA: 2, nestedZ: 1 });
  expect(providerData.alpha).toBe(42);
});
