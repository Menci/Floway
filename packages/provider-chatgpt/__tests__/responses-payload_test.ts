import { expect, test } from 'vitest';

import { injectDefaultInstructions } from '../src/responses-default-instructions.ts';
import { stripUnsupportedFields } from '../src/responses-strip-unsupported-fields.ts';
import { compose, defineEnding, run } from '@floway-dev/pipeline';
import { toProviderModelFacts, type ProviderResponsesInput, type ProviderServices } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

type Payload = ProviderResponsesInput['request.payload'];
type PayloadFacts = Pick<ProviderResponsesInput, 'request.payload'>;

const payloadPipeline = compose<ProviderResponsesInput, ProviderServices>()('responses.payload', {
  entry: ['provider.model', 'request.payload'],
  exit: ['request.payload'],
  stages: [injectDefaultInstructions, stripUnsupportedFields],
  ending: defineEnding<PayloadFacts, PayloadFacts, {}, ProviderServices>({
    name: 'capture-payload',
    request: { needs: ['request.payload'] },
    return: { provides: ['request.payload'] },
    async execute(facts) {
      return { 'request.payload': facts['request.payload'] };
    },
  }),
});

const shapePayload = async (payload: Payload, useResponsesLite = false): Promise<Payload> => {
  const handle = run(payloadPipeline, {
    'provider.model': toProviderModelFacts(stubProviderModel({ endpoints: { openaiResponses: {} }, providerData: { useResponsesLite } })),
    'request.payload': payload,
  }, {
    services: { fetcher: () => { throw new Error('unexpected network request'); } },
    finalizationTimeoutMs: 1000,
  });
  const result = await handle.result;
  expect(await handle.done).toEqual({ ok: true });
  return result['request.payload'];
};

test('injects the default when instructions is absent', async () => {
  const payload = await shapePayload({ input: [{ type: 'message', role: 'user', content: 'hello' }] });
  expect(payload.instructions).toBe("You're a helpful assistant.");
});

test('preserves absent Lite instructions and the caller input', async () => {
  const input: Payload['input'] = [
    { type: 'additional_tools', role: 'developer', tools: [] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Caller base instructions' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } },
  ];
  const payload = await shapePayload({ input }, true);
  expect(payload.instructions).toBeUndefined();
  expect(payload.input).toBe(input);
});

test('drops every field Codex rejects with Unsupported parameter', async () => {
  const fields = {
    max_output_tokens: 1024,
    temperature: 0.7,
    top_p: 0.9,
    frequency_penalty: 0.1,
    presence_penalty: 0.2,
    user: 'caller-id',
    metadata: { trace_id: 'abc' },
    prompt_cache_retention: '24h',
    safety_identifier: 'caller-supplied',
    stream_options: { include_usage: true, include_obfuscation: true },
  } as const;
  const payload = await shapePayload({ ...fields, input: [{ type: 'message', role: 'user', content: 'hello' }] });
  for (const field of Object.keys(fields)) expect(payload).not.toHaveProperty(field);
});
