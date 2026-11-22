import { expect, test } from 'vitest';

import { stripChatGPTUnsupportedFields } from '../../../src/responses-fields.ts';
import { defaultChatGPTInstructions } from '../../../src/responses-instructions.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProviderModel } from '@floway-dev/provider';
import { assertFalse, assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const model = (useResponsesLite: boolean): Pick<ProviderModel, 'id' | 'providerData'> => stubProviderModel({
  id: 'gpt-test',
  endpoints: { openaiResponses: {} },
  providerData: { useResponsesLite },
});

test('ChatGPT injects default instructions only for non-Lite models', () => {
  const payload: Omit<CanonicalOpenAIResponsesPayload, 'model'> = {
    input: [{ type: 'message', role: 'user', content: 'hello' }],
  };
  const standard = defaultChatGPTInstructions(payload, model(false));
  assertEquals(standard.instructions, "You're a helpful assistant.");

  const lite = defaultChatGPTInstructions(payload, model(true));
  assertEquals(lite.instructions, undefined);
  assertEquals(lite.input, payload.input);
});

test('ChatGPT strips every unsupported Responses field and retains supported fields', () => {
  const payload = {
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    reasoning: { effort: 'medium' },
    max_output_tokens: 1024,
    temperature: 0.7,
    top_p: 0.9,
    frequency_penalty: 0.1,
    presence_penalty: 0.2,
    user: 'caller-id',
    metadata: { trace_id: 'abc' },
    prompt_cache_retention: '24h',
    safety_identifier: 'caller-supplied',
    stream_options: { include_usage: true },
  } as unknown as Omit<CanonicalOpenAIResponsesPayload, 'model'>;

  const stripped = stripChatGPTUnsupportedFields(payload) as unknown as Record<string, unknown>;
  expect(stripped.input).toEqual(payload.input);
  expect(stripped.tools).toEqual(payload.tools);
  expect(stripped.reasoning).toEqual(payload.reasoning);
  for (const field of [
    'max_output_tokens',
    'temperature',
    'top_p',
    'frequency_penalty',
    'presence_penalty',
    'user',
    'metadata',
    'prompt_cache_retention',
    'safety_identifier',
    'stream_options',
  ]) assertFalse(field in stripped, `expected ${field} to be stripped`);
});
