import { expect, test } from 'vitest';

import { toPublicModel } from '../../../src/data-plane/models/load.ts';
import { internalModelFromProviderModel } from '../../../src/data-plane/providers/catalog.ts';
import { createPreviewProvider, resolveProviderModelCompatibility } from '../../../src/data-plane/providers/registry.ts';
import { buildCustomUpstreamRecord } from '../../test-utils/app.ts';
import { compatibilityField, endpointAvailabilityField } from '@floway-dev/provider';
import { stubProviderModel, testFetcher } from '@floway-dev/test-utils';

test('upstream and per-model reasoning overrides inherit independently without enabling native endpoints', async () => {
  const record = buildCustomUpstreamRecord({ compatibility: { openaiChatCompletions: { reasoning: { text: 'reasoning' } } }, config: { baseUrl: 'https://example.com', authStyle: 'none', ingressHeadersRules: [], endpoints: {}, modelsFetch: { enabled: false }, models: [{ upstreamModelId: 'm', kind: 'chat', endpoints: { openaiChatCompletions: {} }, compatibility: { openaiChatCompletions: { reasoning: { data: 'litellm-thinking-blocks' } } } }, { upstreamModelId: 'a', kind: 'chat', endpoints: { anthropicMessages: {} } }] } });
  const models = await createPreviewProvider(record).instance.getProvidedModels(testFetcher);
  expect(models[0].resolvedCompatibility?.openaiChatCompletions.reasoning).toEqual({ text: 'reasoning', data: 'litellm-thinking-blocks' });
  expect(models[0].compatibility?.openaiChatCompletions?.reasoning).toEqual({ data: 'litellm-thinking-blocks' });
  expect(models[1].endpoints).toEqual({ anthropicMessages: {} });
  const publicModel = toPublicModel(internalModelFromProviderModel(models[1], record.id));
  expect(publicModel.endpoints).toEqual({ anthropicMessages: {}, openaiResponses: {}, openaiChatCompletions: {} });
});

test('provider auto model choices occupy the per-model layer above operator upstream overrides', () => {
  const record = buildCustomUpstreamRecord({ compatibility: { openaiChatCompletions: { reasoning: { text: 'reasoning', data: 'passthrough' } } } });
  const raw = stubProviderModel({ compatibility: { openaiChatCompletions: { reasoning: { text: 'reasoning-text', data: 'openrouter-reasoning-details' } } } });
  expect(resolveProviderModelCompatibility(record, raw).resolvedCompatibility?.openaiChatCompletions.reasoning).toEqual({ text: 'reasoning-text', data: 'openrouter-reasoning-details' });
});

test('public metadata exposes endpoint availability without compatibility preferences', () => {
  const record = buildCustomUpstreamRecord({ compatibility: { openaiChatCompletions: { reasoning: { text: 'reasoning-content', data: 'reasoning-opaque' } } } });
  const model = resolveProviderModelCompatibility(record, stubProviderModel());
  const publicModel = toPublicModel(internalModelFromProviderModel(model, record.id));
  expect(publicModel.endpoints.openaiChatCompletions).toEqual({});
  expect(publicModel).not.toHaveProperty('compatibility');
  expect(publicModel).not.toHaveProperty('resolvedCompatibility');
});

test('compatibility validates sparse protocol preferences independently of endpoint availability', () => {
  const compatibility = { openaiChatCompletions: { reasoning: { data: 'passthrough' } } };
  expect(compatibilityField(compatibility, 'model.compatibility')).toEqual(compatibility);
  expect(() => compatibilityField({ openaiChatCompletions: { reasoningFormat: {} } }, 'model.compatibility')).toThrow('unknown field');
  expect(() => compatibilityField({ openaiChatCompletions: { reasoning: { text: 'reasoning_aaacontent' } } }, 'model.compatibility')).toThrow('reasoning.text');
  expect(() => endpointAvailabilityField({ openaiChatCompletions: { reasoning: {} } }, 'model.endpoints')).toThrow('configure protocol options through compatibility');
});

test.each(['litellm-reasoning-items'])('internal data standard %s cannot become an operator preference', data => {
  expect(() => compatibilityField({ openaiChatCompletions: { reasoning: { data } } }, 'model.compatibility')).toThrow('reasoning.data');
});
