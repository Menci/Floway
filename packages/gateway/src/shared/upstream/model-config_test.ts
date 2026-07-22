import { test } from 'vitest';

import { modelsField } from '@floway-dev/provider';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('modelsField parses a full model entry', () => {
  const models = modelsField(
    [
      {
        upstreamModelId: 'gpt-prod',
        publicModelId: 'gpt-5',
        endpoints: { chatCompletions: {}, responses: {} },
        display_name: 'GPT Prod',
        limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
        pricing: { entries: [{ rates: { input_tokens: '2.5', output_tokens: '15', input_cache_read_tokens: '0.25', input_cache_write_tokens: '3.75' } }] },
        flagOverrides: { 'vendor-deepseek': false },
      },
    ],
    'azure',
  );

  assertEquals(models, [
    {
      upstreamModelId: 'gpt-prod',
      publicModelId: 'gpt-5',
      kind: 'chat',
      endpoints: { chatCompletions: {}, responses: {} },
      display_name: 'GPT Prod',
      limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
      pricing: { entries: [{ rates: { input_tokens: '2.5', output_tokens: '15', input_cache_read_tokens: '0.25', input_cache_write_tokens: '3.75' } }] },
      flagOverrides: { 'vendor-deepseek': false },
    },
  ]);
});

test('modelsField parses a minimal model entry', () => {
  const models = modelsField(
    [{ upstreamModelId: 'gpt-prod', endpoints: { chatCompletions: {} } }],
    'custom',
  );

  assertEquals(models, [{ upstreamModelId: 'gpt-prod', kind: 'chat', endpoints: { chatCompletions: {} } }]);
});

test('modelsField rejects a missing upstreamModelId', () => {
  assertThrows(
    () => modelsField([{ endpoints: { chatCompletions: {} } }], 'azure'),
    Error,
    'Malformed azure models[0].upstreamModelId: must be a non-empty string',
  );
});

test('modelsField returns an empty array for an empty list', () => {
  assertEquals(modelsField([], 'custom'), []);
});

test('modelsField rejects a non-array', () => {
  assertThrows(
    () => modelsField({}, 'custom'),
    Error,
    'Malformed custom upstream config: models must be an array',
  );
});

test('modelsField rejects a non-object entry', () => {
  assertThrows(
    () => modelsField(['not-an-object'], 'azure'),
    Error,
    'Malformed azure models[0]: must be an object',
  );
});

test('modelsField rejects an empty endpoints object', () => {
  assertThrows(
    () => modelsField([{ upstreamModelId: 'gpt-prod', endpoints: {  } }], 'azure'),
    Error,
    'Malformed azure models[0].endpoints: must declare at least one endpoint',
  );
});

test('modelsField rejects an unsupported endpoint key', () => {
  assertThrows(
    () => modelsField([{ upstreamModelId: 'gpt-prod', endpoints: { bogus: {} } }], 'azure'),
    Error,
    'Malformed azure models[0].endpoints: unsupported endpoint bogus',
  );
});

test('modelsField derives kind from endpoints when omitted', () => {
  const [embedding] = modelsField([{ upstreamModelId: 'e', endpoints: { embeddings: {} } }], 'custom');
  assertEquals(embedding.kind, 'embedding');
  const [image] = modelsField([{ upstreamModelId: 'i', endpoints: { imagesGenerations: {}, imagesEdits: {} } }], 'custom');
  assertEquals(image.kind, 'image');
  const [chat] = modelsField([{ upstreamModelId: 'c', endpoints: { responses: {} } }], 'custom');
  assertEquals(chat.kind, 'chat');
});

test('modelsField accepts a valid kind and rejects an unknown one', () => {
  const models = modelsField(
    [{ upstreamModelId: 'm', kind: 'embedding', endpoints: { embeddings: {} } }],
    'custom',
  );
  assertEquals(models[0].kind, 'embedding');
  assertThrows(
    () => modelsField([{ upstreamModelId: 'm', kind: 'bogus', endpoints: { chatCompletions: {} } }], 'custom'),
    Error,
    'Malformed custom models[0].kind: must be one of chat, embedding, image, rerank',
  );
});

test('modelsField accepts pricing with only a subset of metrics set', () => {
  const models = modelsField(
    [{ upstreamModelId: 'gpt-prod', endpoints: { chatCompletions: {} }, pricing: { entries: [{ rates: { input_tokens: '2.5' } }] } }],
    'azure',
  );
  assertEquals(models[0].pricing, { entries: [{ rates: { input_tokens: '2.5' } }] });
});

test('modelsField rejects pricing with a negative input', () => {
  assertThrows(
    () =>
      modelsField(
        [{ upstreamModelId: 'gpt-prod', endpoints: { chatCompletions: {} }, pricing: { entries: [{ rates: { input_tokens: '-1', output_tokens: '1' } }] } }],
        'azure',
      ),
    Error,
    'pricing.entries[0].rates.input_tokens must be non-negative',
  );
});

test('modelsField rejects a non-object flagOverrides', () => {
  assertThrows(
    () =>
      modelsField(
        [
          {
            upstreamModelId: 'gpt-prod',
            endpoints: { chatCompletions: {} },
            flagOverrides: 'not-an-object',
          },
        ],
        'azure',
      ),
    Error,
    'Malformed azure models[0].flagOverrides: must be an object',
  );
});

test('modelsField rejects flagOverrides with an unknown flag id', () => {
  assertThrows(
    () =>
      modelsField(
        [
          {
            upstreamModelId: 'gpt-prod',
            endpoints: { chatCompletions: {} },
            flagOverrides: { 'made-up-flag': true },
          },
        ],
        'azure',
      ),
    Error,
    'Malformed azure models[0].flagOverrides: unknown flag ids: made-up-flag',
  );
});
