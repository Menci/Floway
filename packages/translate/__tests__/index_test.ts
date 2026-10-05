import { test } from 'vitest';

import {
  translateAnthropicMessagesViaOpenAIChatCompletions,
  translateAnthropicMessagesViaOpenAIResponses,
  translateGeminiGenerateContentViaAnthropicMessages,
  translateGeminiGenerateContentViaOpenAIChatCompletions,
  translateGeminiGenerateContentViaOpenAIResponses,
  translateOpenAIChatCompletionsViaAnthropicMessages,
  translateOpenAIChatCompletionsViaOpenAIResponses,
  translateOpenAIResponsesViaAnthropicMessages,
  translateOpenAIResponsesViaOpenAIChatCompletions,
} from '../src/index.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPrivateContext, OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

const reasoning: OpenAIChatCompletionsPrivateContext = {
  preference: { textFieldName: 'reasoning', reasoningEncapsulationFormat: 'openrouter-reasoning_details' },
  codec: { encapsulate: async () => { throw new Error('Unexpected encapsulation'); }, unencapsulate: async () => undefined },
};

const schema = { type: 'object' as const, properties: { x: { type: 'string' } } };
const formatSchema = { type: 'object', properties: { y: { type: 'string' } } };

const responses: CanonicalOpenAIResponsesPayload = {
  model: 'm',
  input: [
    { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'thought' }] },
    { type: 'message', role: 'user', content: 'hi' },
  ],
  tools: [{ type: 'function', name: 'f', parameters: schema }],
  text: { format: { type: 'json_schema', name: 'f', schema: formatSchema } },
  metadata: { nested: 'x' },
};
const chat: OpenAIChatCompletionsPayload = {
  model: 'm',
  messages: [
    { role: 'assistant', content: 'hello', reasoning_items: [{ type: 'reasoning', id: 'rs2', summary: [{ type: 'summary_text', text: 'thought' }] }] } as OpenAIChatCompletionsAssistantMessageEx,
    { role: 'user', content: 'hi' },
  ],
  tools: [{ type: 'function', function: { name: 'f', parameters: schema } }],
  response_format: { type: 'json_schema', json_schema: { name: 'f', schema: formatSchema } },
  metadata: { nested: 'x' },
  stop: ['END'],
  tool_choice: 'auto',
};
const anthropic: AnthropicMessagesPayload = {
  model: 'm', max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'f', input_schema: schema }],
  output_config: { format: { type: 'json_schema', schema: formatSchema } },
  stop_sequences: ['END'],
  metadata: { user_id: 'u', extension: { nested: 'retained' } } as AnthropicMessagesPayload['metadata'],
};
const gemini: GeminiGenerateContentPayload = {
  contents: [
    { role: 'model', parts: [{ functionCall: { name: 'f', args: { nested: { value: 'x' } } } }] },
    { role: 'user', parts: [{ text: 'hi' }] },
  ],
  tools: [{ functionDeclarations: [{ name: 'f', parameters: schema }] }],
  generationConfig: { responseSchema: formatSchema, stopSequences: ['END'], maxOutputTokens: 16 },
};

const objectsIn = (value: unknown): Set<object> => {
  const objects = new Set<object>();
  const visit = (current: unknown): void => {
    if (typeof current !== 'object' || current === null || objects.has(current)) return;
    objects.add(current);
    for (const child of Object.values(current)) visit(child);
  };
  visit(value);
  return objects;
};

const translations: Array<{ name: string; source: unknown; translate: () => Promise<unknown> }> = [
  { name: 'Responses to Chat Completions', source: responses, translate: async () => (await translateOpenAIResponsesViaOpenAIChatCompletions(responses, { model: 'm', privateContext: reasoning })).target },
  { name: 'Responses to Anthropic Messages', source: responses, translate: async () => (await translateOpenAIResponsesViaAnthropicMessages(responses, { model: 'm', loadRemoteImage: async () => { throw new Error('Unexpected remote image'); } })).target },
  { name: 'Chat Completions to Responses', source: chat, translate: async () => (await translateOpenAIChatCompletionsViaOpenAIResponses(chat, { model: 'm', privateContext: reasoning })).target },
  { name: 'Chat Completions to Anthropic Messages', source: chat, translate: async () => (await translateOpenAIChatCompletionsViaAnthropicMessages(chat, { model: 'm', privateContext: reasoning, loadRemoteImage: async () => { throw new Error('Unexpected remote image'); } })).target },
  { name: 'Anthropic Messages to Responses', source: anthropic, translate: async () => (await translateAnthropicMessagesViaOpenAIResponses(anthropic, { model: 'm' })).target },
  { name: 'Anthropic Messages to Chat Completions', source: anthropic, translate: async () => (await translateAnthropicMessagesViaOpenAIChatCompletions(anthropic, { model: 'm', privateContext: reasoning })).target },
  { name: 'Gemini to Responses', source: gemini, translate: async () => (await translateGeminiGenerateContentViaOpenAIResponses(gemini, { model: 'm', privateContext: reasoning })).target },
  { name: 'Gemini to Chat Completions', source: gemini, translate: async () => (await translateGeminiGenerateContentViaOpenAIChatCompletions(gemini, { model: 'm', privateContext: reasoning })).target },
  { name: 'Gemini to Anthropic Messages', source: gemini, translate: async () => (await translateGeminiGenerateContentViaAnthropicMessages(gemini, { model: 'm', fallbackMaxOutputTokens: 16, privateContext: reasoning })).target },
];

test.each(translations)('$name owns its target payload without retaining source or prior target objects', async ({ source, translate }) => {
  const original = structuredClone(source);
  const first = await translate();
  const second = await translate();
  const sourceObjects = objectsIn(source);
  const firstObjects = objectsIn(first);
  const secondObjects = objectsIn(second);

  assertEquals(source, original);
  for (const object of firstObjects) assertEquals(sourceObjects.has(object), false);
  for (const object of secondObjects) {
    assertEquals(sourceObjects.has(object), false);
    assertEquals(firstObjects.has(object), false);
  }
});
