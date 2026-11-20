import { test } from 'vitest';

import { injectDefaultInstructions } from '../../../src/interceptors/openai-responses/inject-default-instructions.ts';
import type { OpenAIResponsesBoundaryCtx } from '../../../src/interceptors/openai-responses/types.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ProviderStreamResult<OpenAIResponsesStreamEventEx>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test', http: { status: 200, headers: new Headers() } });

const invocation = (payload: CanonicalOpenAIResponsesPayload, useResponsesLite = false): OpenAIResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { openaiResponses: {} }, providerData: { useResponsesLite } }),
  action: 'generate',
});

test('injects the default when instructions is absent', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }] });

  await injectDefaultInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, "You're a helpful assistant.");
});

test('preserves absent Lite instructions and the caller input', async () => {
  const input: CanonicalOpenAIResponsesPayload['input'] = [
    { type: 'additional_tools', role: 'developer', tools: [] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Caller base instructions' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } },
  ];
  const ctx = invocation({ model: 'gpt-test', input }, true);

  await injectDefaultInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, undefined);
  assertEquals(ctx.payload.input, input);
});
