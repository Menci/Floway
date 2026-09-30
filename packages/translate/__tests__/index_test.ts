import { expect, test } from 'vitest';

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
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

const schema = { type: 'object', properties: { x: { type: 'string' } } };
const formatSchema = { type: 'object', properties: { y: { type: 'string' } } };

const responses: CanonicalOpenAIResponsesPayload = {
  model: 'm',
  input: [
    { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'thought' }] },
    { type: 'message', role: 'user', content: 'hi' },
  ],
  tools: [{ type: 'function', name: 'f', parameters: schema }],
  text: { format: { type: 'json_schema', name: 'f', schema: formatSchema } },
  metadata: { nested: { value: 'x' } },
};
const chat: OpenAIChatCompletionsPayload = {
  model: 'm',
  messages: [
    { role: 'assistant', content: 'hello', reasoning_items: [{ type: 'reasoning', id: 'rs2', summary: [{ type: 'summary_text', text: 'thought' }] }] },
    { role: 'user', content: 'hi' },
  ],
  tools: [{ type: 'function', function: { name: 'f', parameters: schema } }],
  response_format: { type: 'json_schema', json_schema: { name: 'f', schema: formatSchema } },
  metadata: { nested: { value: 'x' } },
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
  { name: 'Responses to Chat Completions', source: responses, translate: async () => (await translateOpenAIResponsesViaOpenAIChatCompletions(responses, { model: 'm' })).target },
  { name: 'Responses to Anthropic Messages', source: responses, translate: async () => (await translateOpenAIResponsesViaAnthropicMessages(responses, { model: 'm', loadRemoteImage: async () => { throw new Error('Unexpected remote image'); } })).target },
  { name: 'Chat Completions to Responses', source: chat, translate: async () => (await translateOpenAIChatCompletionsViaOpenAIResponses(chat, { model: 'm' })).target },
  { name: 'Chat Completions to Anthropic Messages', source: chat, translate: async () => (await translateOpenAIChatCompletionsViaAnthropicMessages(chat, { model: 'm', loadRemoteImage: async () => { throw new Error('Unexpected remote image'); } })).target },
  { name: 'Anthropic Messages to Responses', source: anthropic, translate: async () => (await translateAnthropicMessagesViaOpenAIResponses(anthropic, { model: 'm' })).target },
  { name: 'Anthropic Messages to Chat Completions', source: anthropic, translate: async () => (await translateAnthropicMessagesViaOpenAIChatCompletions(anthropic, { model: 'm' })).target },
  { name: 'Gemini to Responses', source: gemini, translate: async () => (await translateGeminiGenerateContentViaOpenAIResponses(gemini, { model: 'm' })).target },
  { name: 'Gemini to Chat Completions', source: gemini, translate: async () => (await translateGeminiGenerateContentViaOpenAIChatCompletions(gemini, { model: 'm' })).target },
  { name: 'Gemini to Anthropic Messages', source: gemini, translate: async () => (await translateGeminiGenerateContentViaAnthropicMessages(gemini, { model: 'm', fallbackMaxOutputTokens: 16 })).target },
];

const freezeJson = <T>(value: T): T => {
  for (const object of objectsIn(value)) Object.freeze(object);
  return value;
};

test.each(translations)('$name preserves frozen sources and shares unchanged schemas across trips', async ({ source, translate }) => {
  freezeJson(source);
  const original = JSON.stringify(source);
  const first = freezeJson(await translate());
  const second = freezeJson(await translate());
  const sourceObjects = objectsIn(source);
  const shared = [...objectsIn(first)].filter(object => sourceObjects.has(object));
  expect(shared).toContain(schema);
  expect(objectsIn(second).has(schema)).toBe(true);
  expect(JSON.stringify(source)).toBe(original);

  const firstBody = first as { tools: Array<Record<string, unknown>> };
  const tool = firstBody.tools[0];
  const nested = tool.function as Record<string, unknown> | undefined;
  const field = nested ? 'parameters' : 'input_schema' in tool ? 'input_schema' : 'parameters';
  const originalSchema = (nested ?? tool)[field] as typeof schema;
  expect(() => { originalSchema.properties.x.type = 'number'; }).toThrow(TypeError);
  const rewrittenSchema = { ...originalSchema, properties: { ...originalSchema.properties, providerOnly: { type: 'boolean' } } };
  const rewrittenTool = nested ? { ...tool, function: { ...nested, [field]: rewrittenSchema } } : { ...tool, [field]: rewrittenSchema };
  const rewritten = { ...firstBody, tools: [rewrittenTool, ...firstBody.tools.slice(1)] };
  expect(rewritten.tools[0]).not.toBe(tool);
  expect(originalSchema).toBe(schema);
  expect(originalSchema.properties).not.toHaveProperty('providerOnly');
  expect(JSON.stringify(source)).toBe(original);
  expect(objectsIn(second).has(schema)).toBe(true);
});
