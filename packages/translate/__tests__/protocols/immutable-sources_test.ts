import { expect, test } from 'vitest';

import { fixtureFrames, type IRTestProtocol } from './fixtures.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import { deepFreeze } from '../shared/deep-freeze.ts';
import { collect, iterate } from '../shared/iterables.ts';
import { expectTrip } from '../trip.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';
import {
  routeAnthropicMessagesViaOpenAIChatCompletions,
  routeAnthropicMessagesViaOpenAIResponses,
  routeGeminiGenerateContentViaAnthropicMessages,
  routeGeminiGenerateContentViaOpenAIChatCompletions,
  routeGeminiGenerateContentViaOpenAIResponses,
  routeOpenAIChatCompletionsViaAnthropicMessages,
  routeOpenAIChatCompletionsViaOpenAIResponses,
  routeOpenAIResponsesViaAnthropicMessages,
  routeOpenAIResponsesViaOpenAIChatCompletions,
  type TranslateInputError,
  type TranslateOptions,
} from '@floway-dev/translate';

const parameters = {
  type: 'object',
  properties: { query: { type: 'string', enum: ['a', 'b'] }, filters: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' } } } } },
  required: ['query'],
};
const responseSchema = { type: 'object', properties: { answer: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } } };
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X3p0kAAAAASUVORK5CYII=';

const responses: OpenAIResponsesRequestPayloadEx = {
  model: 'm',
  stream: true,
  instructions: 'Answer briefly.',
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Prefer citations.' }] },
    {
      type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'Look at these.' },
        { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'high' },
        { type: 'input_file', file_data: `data:application/pdf;base64,${pixel}`, filename: 'a.pdf' },
      ],
    },
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Considering.' }], content: [{ type: 'reasoning_text', text: 'Detail.' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Calling tools.', annotations: [] }] },
    { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"query":"a","filters":[{"key":"k"}]}' },
    { type: 'custom_tool_call', call_id: 'call_2', name: 'patch', input: '*** Begin Patch' },
    { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'found' }, { type: 'input_image', image_url: 'https://example.com/b.png' }] },
    { type: 'custom_tool_call_output', call_id: 'call_2', output: 'applied' },
    { type: 'message', role: 'user', content: 'Continue.' },
  ],
  tools: [
    { type: 'function', name: 'lookup', description: 'Look up.', parameters, strict: false },
    { type: 'custom', name: 'patch', description: 'Patch files.', format: { type: 'grammar', syntax: 'lark', definition: 'start: "x"' } },
    { type: 'namespace', name: 'docs', description: 'Documentation.', tools: [{ type: 'function', name: 'search', description: 'Search docs.', parameters }] },
  ],
  tool_choice: 'auto',
  parallel_tool_calls: false,
  text: { format: { type: 'json_schema', name: 'answer', schema: responseSchema, strict: true }, verbosity: 'low' },
  reasoning: { effort: 'high', summary: 'auto' },
  metadata: { trace: 't' },
  max_output_tokens: 256,
  temperature: 0.5,
  prompt_cache_key: 'cache',
  include: ['message.output_text.logprobs'],
} as OpenAIResponsesRequestPayloadEx;

const chat: OpenAIChatCompletionsPayload = {
  model: 'm',
  stream: true,
  messages: [
    { role: 'system', content: 'Answer briefly.' },
    { role: 'developer', content: [{ type: 'text', text: 'Prefer citations.' }] },
    {
      role: 'user', content: [
        { type: 'text', text: 'Look at these.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${pixel}`, detail: 'low' } },
        { type: 'file', file: { file_data: `data:application/pdf;base64,${pixel}`, filename: 'a.pdf' } },
      ],
    },
    {
      role: 'assistant', content: 'Calling tools.', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"query":"a"}' } },
        { id: 'call_2', type: 'custom', custom: { name: 'patch', input: '*** Begin Patch' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'found' }] },
    { role: 'tool', tool_call_id: 'call_2', content: 'applied' },
    { role: 'assistant', content: null, function_call: { name: 'lookup', arguments: '{"query":"b"}' } },
    { role: 'function', name: 'lookup', content: 'found again' },
    { role: 'user', content: 'Continue.' },
  ],
  tools: [
    { type: 'function', function: { name: 'lookup', description: 'Look up.', parameters, strict: false } },
    { type: 'custom', custom: { name: 'patch', description: 'Patch files.', format: { type: 'grammar', grammar: { syntax: 'lark', definition: 'start: "x"' } } } },
  ],
  tool_choice: { type: 'allowed_tools', allowed_tools: { mode: 'auto', tools: [{ type: 'function', function: { name: 'lookup' } }, { type: 'custom', custom: { name: 'patch' } }] } },
  parallel_tool_calls: true,
  response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: responseSchema, strict: true } },
  metadata: { trace: 't' },
  stop: ['END', 'STOP'],
  max_completion_tokens: 256,
  reasoning_effort: 'medium',
  prompt_cache_key: 'cache',
  prompt_cache_options: { mode: 'explicit', ttl: '1h' },
  logprobs: true,
  top_logprobs: 2,
} as OpenAIChatCompletionsPayload;

const anthropic: AnthropicMessagesPayload = {
  model: 'm',
  max_tokens: 256,
  stream: true,
  system: [{ type: 'text', text: 'Answer briefly.', cache_control: { type: 'ephemeral' } }],
  messages: [
    {
      role: 'user', content: [
        { type: 'text', text: 'Look at these.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pixel } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pixel }, title: 'A', citations: { enabled: true }, cache_control: { type: 'ephemeral' } },
      ],
    },
    {
      role: 'assistant', content: [
        { type: 'thinking', thinking: 'Considering.', signature: 'sig' },
        { type: 'text', text: 'Calling tools.' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { query: 'a', filters: [{ key: 'k' }] } },
      ],
    },
    {
      role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'found' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pixel } }] },
        { type: 'text', text: 'Continue.' },
      ],
    },
  ],
  tools: [
    { name: 'lookup', description: 'Look up.', input_schema: parameters },
    { type: 'web_search_20250305', name: 'web_search' },
  ],
  tool_choice: { type: 'auto', disable_parallel_tool_use: true },
  output_config: { format: { type: 'json_schema', schema: responseSchema }, effort: 'high' },
  thinking: { type: 'enabled', budget_tokens: 1024 },
  metadata: { user_id: 'u' },
  stop_sequences: ['END'],
  temperature: 1,
  top_k: 5,
} as AnthropicMessagesPayload;

const gemini: GeminiGenerateContentRequest = {
  model: 'm',
  systemInstruction: { parts: [{ text: 'Answer briefly.' }] },
  contents: [
    { role: 'user', parts: [{ text: 'Look at this.' }, { inlineData: { mimeType: 'image/png', data: pixel } }] },
    {
      role: 'model', parts: [
        { text: 'Considering.', thought: true },
        { text: 'Calling tools.' },
        { functionCall: { name: 'lookup', args: { query: 'a', filters: [{ key: 'k' }] } } },
      ],
    },
    { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { result: { found: ['x'] } } } }, { text: 'Continue.' }] },
  ],
  tools: [{
    functionDeclarations: [
      {
        name: 'lookup', description: 'Look up.',
        parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', nullable: true }, filters: { type: 'ARRAY', minItems: '1', items: { type: 'OBJECT', properties: { key: { type: 'STRING' } } } } }, propertyOrdering: ['filters', 'query'], required: ['query'] },
      },
      { name: 'search', description: 'Search docs.', parametersJsonSchema: parameters },
    ],
  }],
  toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] } },
  generationConfig: {
    responseJsonSchema: responseSchema,
    stopSequences: ['END'],
    maxOutputTokens: 256,
    temperature: 0.5,
    thinkingConfig: { thinkingBudget: 1024 },
  },
} as GeminiGenerateContentRequest;

type Trip = { readonly type: 'trip'; readonly target: unknown; readonly events: (frames: AsyncIterable<any>) => AsyncIterable<unknown> };

const options = (): TranslateOptions => ({ sidecarCodec: createTestSidecarCodec('immutable-sources'), fallbackMaxOutputTokens: 256 });

const routes: { name: string; source: unknown; target: IRTestProtocol; translate: (payload: any, options: TranslateOptions) => Promise<Trip | TranslateInputError> }[] = [
  { name: 'Responses via Chat Completions', source: responses, target: 'openai-chat-completions', translate: routeOpenAIResponsesViaOpenAIChatCompletions },
  { name: 'Responses via Anthropic Messages', source: responses, target: 'anthropic-messages', translate: routeOpenAIResponsesViaAnthropicMessages },
  { name: 'Chat Completions via Responses', source: chat, target: 'openai-responses', translate: routeOpenAIChatCompletionsViaOpenAIResponses },
  { name: 'Chat Completions via Anthropic Messages', source: chat, target: 'anthropic-messages', translate: routeOpenAIChatCompletionsViaAnthropicMessages },
  { name: 'Anthropic Messages via Responses', source: anthropic, target: 'openai-responses', translate: routeAnthropicMessagesViaOpenAIResponses },
  { name: 'Anthropic Messages via Chat Completions', source: anthropic, target: 'openai-chat-completions', translate: routeAnthropicMessagesViaOpenAIChatCompletions },
  { name: 'GenerateContent via Responses', source: gemini, target: 'openai-responses', translate: routeGeminiGenerateContentViaOpenAIResponses },
  { name: 'GenerateContent via Chat Completions', source: gemini, target: 'openai-chat-completions', translate: routeGeminiGenerateContentViaOpenAIChatCompletions },
  { name: 'GenerateContent via Anthropic Messages', source: gemini, target: 'anthropic-messages', translate: routeGeminiGenerateContentViaAnthropicMessages },
];

test.each(routes)('$name translates a frozen source payload and frozen upstream frames without writing into them', async ({ source, target, translate }) => {
  const payload = deepFreeze(structuredClone(source));
  const trip = expectTrip(await translate(payload, options()));
  const frames = deepFreeze(fixtureFrames(target, {
    text: ['answer'], thinking: ['thought'], signature: 'native signature',
    tools: [{ name: 'lookup', id: 'upstream-call', args: { query: 'a' } }],
  }));
  const returned = await collect(trip.events(iterate(frames)));

  expect(returned.length).toBeGreaterThan(0);
  expect(payload).toEqual(source);
});
