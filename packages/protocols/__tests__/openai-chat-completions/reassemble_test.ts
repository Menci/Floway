import { test } from 'vitest';

import type { OpenAIChatCompletionsAssistantOutputMessageEx, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsResult, OpenAIChatCompletionsAssistantDeltaEx } from '../../src/openai-chat-completions/index.ts';
import { reassembleOpenAIChatCompletionsEvents } from '../../src/openai-chat-completions/reassemble.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

function makeEvents<T = OpenAIChatCompletionsStreamEvent>(chunks: Array<{ event?: string; data: unknown }>): AsyncIterable<T> {
  return (async function* () {
    for (const chunk of chunks) {
      if (typeof chunk.data === 'string') continue;

      const data = chunk.data as Record<string, unknown>;
      yield (chunk.event && typeof data.type !== 'string' ? { ...data, type: chunk.event } : data) as T;
    }
  })();
}

test('reassembleOpenAIChatCompletionsEvents rejects upstream OpenAI Chat Completions error payloads', async () => {
  const body = makeEvents([
    {
      data: {
        error: {
          type: 'server_error',
          message: 'upstream chat failed',
        },
      },
    },
  ]);

  await assertRejects(async () => await reassembleOpenAIChatCompletionsEvents(body), Error, 'Upstream OpenAI Chat Completions SSE error: server_error: upstream chat failed');
});

test('reassembleOpenAIChatCompletionsEvents concatenates reasoning text and keeps the latest opaque snapshot', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_3',
        object: 'chat.completion.chunk',
        created: 3000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              reasoning_text: 'think',
              reasoning_opaque: 'enc_old',
            } as OpenAIChatCompletionsAssistantDeltaEx,
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        id: 'cmpl_3',
        object: 'chat.completion.chunk',
        created: 3000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: { content: 'reply', reasoning_text: ' more', reasoning_opaque: 'enc' },
            finish_reason: 'stop',
          },
        ],
      },
    },
    { data: '[DONE]' },
  ]);

  const result = await reassembleOpenAIChatCompletionsEvents(body);

  assertEquals((result.choices[0].message as OpenAIChatCompletionsAssistantOutputMessageEx).reasoning_text, 'think more');
  assertEquals((result.choices[0].message as OpenAIChatCompletionsAssistantOutputMessageEx).reasoning_opaque, 'enc');
  assertEquals(result.choices[0].message.content, 'reply');
});

test('reassembleOpenAIChatCompletionsEvents appends complete reasoning items that share an index', async () => {
  const items = ['a', 'b'].map(id => ({
    type: 'reasoning',
    id,
    index: 0,
    summary: [{ type: 'summary_text', text: id }],
  }));
  const expected = structuredClone(items);
  const events = makeEvents(items.map(item => ({
    data: {
      id: 'reasoning', object: 'chat.completion.chunk', created: 1, model: 'model',
      choices: [{ index: 0, delta: { reasoning_items: [item] }, finish_reason: null }],
    },
  })));

  const result = await reassembleOpenAIChatCompletionsEvents(events);
  assertEquals(result.choices[0].message.reasoning_items, expected);
});

test('reassembleOpenAIChatCompletionsEvents maintains independent state for every choice index', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_many',
        object: 'chat.completion.chunk',
        created: 4000,
        model: 'gpt-many',
        choices: [
          {
            index: 1,
            delta: {
              role: 'assistant',
              content: 'second ',
              reasoning_opaque: 'second-old',
              vendor_trace: 'b1',
              tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'beta', arguments: '{"b"' } }],
            } as OpenAIChatCompletionsAssistantDeltaEx,
            finish_reason: null,
            content_filter_results: { hate: { filtered: false } },
          },
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: 'first ',
              reasoning_text: 'think ',
              reasoning_opaque: 'first-old',
              vendor_trace: 'a1',
              vendor_records: [{ type: 'vendor_record', id: 'record_a', segments: [] }],
              tool_calls: [{ index: 1, id: 'call_a', type: 'function', function: { name: 'alpha', arguments: '{"a"' } }],
            } as OpenAIChatCompletionsAssistantDeltaEx,
            finish_reason: null,
            content_filter_results: { sexual: { filtered: false } },
          },
        ],
      },
    },
    {
      data: {
        id: 'cmpl_many',
        object: 'chat.completion.chunk',
        created: 4000,
        model: 'gpt-many',
        choices: [
          {
            index: 0,
            delta: {
              content: 'answer',
              reasoning_text: 'again',
              reasoning_opaque: 'first-final',
              vendor_trace: 'a2',
              tool_calls: [{ index: 1, function: { arguments: ':1}' } }],
            },
            finish_reason: 'tool_calls',
          },
          {
            index: 1,
            delta: {
              content: 'answer',
              reasoning_opaque: 'second-final',
              vendor_trace: 'b2',
              tool_calls: [{ index: 0, function: { arguments: ':2}' } }],
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      },
    },
  ]);

  const result = await reassembleOpenAIChatCompletionsEvents(body) as OpenAIChatCompletionsResult & {
    choices: Array<OpenAIChatCompletionsResult['choices'][number] & {
      content_filter_results?: unknown;
      message: OpenAIChatCompletionsResult['choices'][number]['message'] & { vendor_trace?: string };
    }>;
  };

  assertEquals(result.choices.map(choice => choice.index), [0, 1]);
  assertEquals(result.choices[0].message.content, 'first answer');
  assertEquals((result.choices[0].message as OpenAIChatCompletionsAssistantOutputMessageEx).reasoning_text, 'think again');
  assertEquals((result.choices[0].message as OpenAIChatCompletionsAssistantOutputMessageEx).reasoning_opaque, 'first-final');
  assertEquals((result.choices[0].message as OpenAIChatCompletionsAssistantOutputMessageEx).vendor_records, [{ type: 'vendor_record', id: 'record_a', segments: [] }]);
  assertEquals(result.choices[0].message.tool_calls, [{ id: 'call_a', type: 'function', function: { name: 'alpha', arguments: '{"a":1}' } }]);
  assertEquals(result.choices[0].message.vendor_trace, 'a1a2');
  assertEquals(result.choices[0].content_filter_results, { sexual: { filtered: false } });
  assertEquals(result.choices[0].finish_reason, 'tool_calls');
  assertEquals(result.choices[1].message.content, 'second answer');
  assertEquals((result.choices[1].message as OpenAIChatCompletionsAssistantOutputMessageEx).reasoning_opaque, 'second-final');
  assertEquals(result.choices[1].message.tool_calls, [{ id: 'call_b', type: 'function', function: { name: 'beta', arguments: '{"b":2}' } }]);
  assertEquals(result.choices[1].message.vendor_trace, 'b1b2');
  assertEquals(result.choices[1].content_filter_results, { hate: { filtered: false } });
  assertEquals(result.choices[1].finish_reason, 'stop');
  assertEquals(result.usage, { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 });
});

test('reassembleOpenAIChatCompletionsEvents treats a null tool_calls as carrying no call', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_null',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'sglang-test',
        choices: [{  index: 0, delta: { role: 'assistant', content: null, tool_calls: null }, finish_reason: null }],
      },
    },
    {
      data: {
        id: 'cmpl_null',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'sglang-test',
        choices: [{  index: 0, delta: { content: 'hi', tool_calls: null }, finish_reason: 'stop' }],
      },
    },
  ]);

  const result = await reassembleOpenAIChatCompletionsEvents(body);

  assertEquals(result.choices[0].message.content, 'hi');
  assertEquals('tool_calls' in result.choices[0].message, false);
});

test('reassembleOpenAIChatCompletionsEvents accumulates refusal deltas separately from content', async () => {
  const result = await reassembleOpenAIChatCompletionsEvents(makeEvents([
    {
      data: {
        id: 'cmpl_refusal',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        choices: [{  index: 0, delta: { role: 'assistant', content: null, refusal: '' }, finish_reason: null }],
      },
    },
    {
      data: {
        id: 'cmpl_refusal',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        choices: [{  index: 0, delta: { refusal: 'Cannot help.' }, finish_reason: null }],
      },
    },
    {
      data: {
        id: 'cmpl_refusal',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        choices: [{  index: 0, delta: {}, finish_reason: 'stop' }],
      },
    },
  ]));

  assertEquals(result.choices[0].message, { role: 'assistant', content: null, refusal: 'Cannot help.' });
  assertEquals(result.choices[0].finish_reason, 'stop');
});

test('assembles native audio with an expiry-only delta lacking finish_reason', async () => {
  const chunk = (delta: OpenAIChatCompletionsStreamEvent['choices'][number]['delta'], finishReason?: 'stop'): OpenAIChatCompletionsStreamEvent => ({
    id: 'audio', object: 'chat.completion.chunk', created: 1, model: 'audio-model',
    choices: [{ index: 0, delta, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
  });
  const events = async function* () {
    yield chunk({ audio: { id: 'aud_1', data: 'first', transcript: 'Hello ' } });
    yield chunk({ audio: { data: 'second', transcript: 'world' } }, 'stop');
    yield chunk({ audio: { expires_at: 1234 } });
  };
  const result = await reassembleOpenAIChatCompletionsEvents(events());
  assertEquals(result.choices[0].message.audio, { id: 'aud_1', data: 'firstsecond', transcript: 'Hello world', expires_at: 1234 });
  assertEquals(result.choices[0].finish_reason, 'stop');
});

test('accumulates legacy function arguments and logprob entries across chunks', async () => {
  const token = { token: 'a', logprob: -1, bytes: [97], top_logprobs: [] };
  const events = async function* (): AsyncGenerator<OpenAIChatCompletionsStreamEvent> {
    yield {
      id: 'legacy', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{
        index: 0, delta: { function_call: { name: 'lookup', arguments: '{' } },
        logprobs: { content: [token], refusal: null }, finish_reason: null,
      }],
    };
    yield {
      id: 'legacy', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{
        index: 0, delta: { function_call: { arguments: '}' } },
        logprobs: { content: [token], refusal: null }, finish_reason: 'function_call',
      }],
    };
  };
  const result = await reassembleOpenAIChatCompletionsEvents(events());
  assertEquals(result.choices[0].message.function_call, { name: 'lookup', arguments: '{}' });
  assertEquals(result.choices[0].logprobs, { content: [token, token], refusal: null });
});

test('collects known tool metadata by dialect without concatenating opaque values', async () => {
  const result = await reassembleOpenAIChatCompletionsEvents(makeEvents([
    { data: { id: 'c', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'lookup', arguments: '' }, extra_content: { google: { thought_signature: 'first' } }, provider_specific_fields: { thought_signature: 'sig', first: 1 } }] } }] } },
    { data: { id: 'c', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' }, extra_content: { google: { thought_signature: 'second', other: 2 } }, provider_specific_fields: { thought_signature: 'sig', second: 2 } }] }, finish_reason: 'tool_calls' }] } },
  ]));
  assertEquals((result.choices[0].message as OpenAIChatCompletionsAssistantOutputMessageEx).tool_calls?.[0], {
    id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' },
    extra_content: { google: { thought_signature: 'first', other: 2 } },
    provider_specific_fields: { thought_signature: 'sig', first: 1, second: 2 },
  });
});
