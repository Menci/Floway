import { expect, test } from 'vitest';

import { toPublicModel } from '../../../src/data-plane/models/load.ts';
import { internalModelFromProviderModel } from '../../../src/data-plane/providers/catalog.ts';
import { createPreviewProvider, resolveProviderModelEndpoints } from '../../../src/data-plane/providers/registry.ts';
import { buildCustomUpstreamRecord } from '../../test-utils/app.ts';
import { compatibilityField, endpointsField } from '@floway-dev/provider';
import { stubProviderModel, testFetcher } from '@floway-dev/test-utils';

test('upstream and per-model reasoning overrides inherit independently without enabling native endpoints', async () => {
  const record = buildCustomUpstreamRecord({ compatibility: { openaiChatCompletions: { reasoning: { text: 'reasoning' } } }, config: { baseUrl: 'https://example.com', authStyle: 'none', ingressHeadersRules: [], endpoints: {}, modelsFetch: { enabled: false }, models: [{ upstreamModelId: 'm', kind: 'chat', endpoints: { openaiChatCompletions: {} }, compatibility: { openaiChatCompletions: { reasoning: { data: 'litellm-thinking-blocks' } } } }, { upstreamModelId: 'a', kind: 'chat', endpoints: { anthropicMessages: {} } }] } });
  const models = await createPreviewProvider(record).instance.getProvidedModels(testFetcher);
  expect(models[0].endpoints.openaiChatCompletions?.reasoning).toEqual({ text: 'reasoning', data: 'litellm-thinking-blocks' });
  expect(models[0].compatibility?.openaiChatCompletions?.reasoning).toEqual({ data: 'litellm-thinking-blocks' });
  expect(models[1].endpoints).toEqual({ anthropicMessages: {} });
  const publicModel = toPublicModel(internalModelFromProviderModel(models[1], record.id));
  expect(publicModel.endpoints).toEqual({ anthropicMessages: {}, openaiResponses: {}, openaiChatCompletions: { reasoning: { text: 'reasoning', data: 'reasoning-opaque' } } });
});

test('provider auto model choices occupy the per-model layer above operator upstream overrides', () => {
  const record = buildCustomUpstreamRecord({ compatibility: { openaiChatCompletions: { reasoning: { text: 'reasoning', data: 'passthrough' } } } });
  const raw = stubProviderModel({ compatibility: { openaiChatCompletions: { reasoning: { text: 'reasoning-text', data: 'openrouter-reasoning-details' } } } });
  expect(resolveProviderModelEndpoints(record, raw).endpoints.openaiChatCompletions?.reasoning).toEqual({ text: 'reasoning-text', data: 'openrouter-reasoning-details' });
});

test.each([
  { upstream: { text: 'passthrough', data: 'passthrough' }, client: { text: 'passthrough', data: 'passthrough' } },
  { upstream: { text: 'reasoning-content', data: 'passthrough' }, client: { text: 'reasoning', data: 'passthrough' } },
  { upstream: { text: 'passthrough', data: 'litellm-thinking-blocks' }, client: { text: 'passthrough', data: 'reasoning-opaque' } },
  { upstream: { text: 'reasoning-text', data: 'openrouter-reasoning-details' }, client: { text: 'reasoning', data: 'reasoning-opaque' } },
] as const)('public model metadata describes the computed response channels ($upstream)', ({ upstream, client }) => {
  const model = internalModelFromProviderModel(stubProviderModel({ endpoints: { openaiChatCompletions: { reasoning: upstream } } }), 'upstream');
  expect(toPublicModel(model).endpoints.openaiChatCompletions?.reasoning).toEqual(client);
});

test('compatibility validates sparse protocol preferences independently of endpoint availability', () => {
  const compatibility = { openaiChatCompletions: { reasoning: { data: 'passthrough' } } };
  expect(compatibilityField(compatibility, 'model.compatibility')).toEqual(compatibility);
  expect(() => compatibilityField({ openaiChatCompletions: { reasoningFormat: {} } }, 'model.compatibility')).toThrow('unknown field');
  expect(() => compatibilityField({ openaiChatCompletions: { reasoning: { text: 'reasoning_aaacontent' } } }, 'model.compatibility')).toThrow('reasoning.text');
  expect(() => endpointsField({ openaiChatCompletions: { reasoning: {} } }, 'model.endpoints')).toThrow('configure protocol options through compatibility');
});
