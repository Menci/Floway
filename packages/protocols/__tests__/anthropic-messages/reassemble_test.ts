import { test } from 'vitest';

import type {
  AnthropicMessagesResult,
  AnthropicMessagesStreamEventEx,
  AnthropicMessagesTextBlock,
} from '../../src/anthropic-messages/index.ts';
import { createAnthropicMessagesEventAccumulator, reassembleAnthropicMessagesEvents } from '../../src/anthropic-messages/reassemble.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

function makeEvents<T = AnthropicMessagesStreamEventEx>(chunks: Array<{ event?: string; data: unknown }>): AsyncIterable<T> {
  return (async function* () {
    for (const chunk of chunks) {
      if (typeof chunk.data === 'string') continue;

      const data = chunk.data as Record<string, unknown>;
      yield (chunk.event && typeof data.type !== 'string' ? { ...data, type: chunk.event } : data) as T;
    }
  })();
}

test('reassembleAnthropicMessagesEvents applies full usage delta extensions while updating cumulative counters', async () => {
  const body = makeEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          container: null, diagnostics: null, stop_details: null,
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { output_tokens_details: null, server_tool_use: null, input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 4, cache_creation_input_tokens: 9, cache_creation: { ephemeral_1h_input_tokens: 5 }, service_tier: 'priority', speed: 'fast', inference_geo: 'us' },
        },
      },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens_details: null, server_tool_use: null, input_tokens: null, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: { ephemeral_1h_input_tokens: 9 }, service_tier: 'standard', speed: 'standard', inference_geo: 'eu' },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const result: AnthropicMessagesResult = await reassembleAnthropicMessagesEvents(body);

  assertEquals(result.usage.input_tokens, 10);
  assertEquals(result.usage.output_tokens, 5);
  assertEquals(result.usage.cache_read_input_tokens, 4);
  assertEquals(result.usage.cache_creation_input_tokens, 9);
  assertEquals(result.usage.cache_creation, { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9 });
  assertEquals(result.usage.service_tier, 'standard');
  assertEquals(result.usage.speed, 'standard');
  assertEquals(result.usage.inference_geo, 'eu');
});

test('reassembleAnthropicMessagesEvents preserves completed tool fields after a max_tokens cutoff', async () => {
  const body = makeEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          container: null, diagnostics: null, stop_details: null,
          id: 'msg_invalid_tool_json',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 20, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_bad', name: 'calc' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"x":42,' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"unfinished":' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: 'max_tokens' },
        usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 10 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const result = await reassembleAnthropicMessagesEvents(body);
  const toolUse = result.content[0] as { type: 'tool_use'; input: Record<string, unknown> };

  assertEquals(result.stop_reason, 'max_tokens');
  assertEquals(toolUse.input, { x: 42 });
});

test('reassembleAnthropicMessagesEvents reassembles thinking blocks', async () => {
  const body = makeEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          container: null, diagnostics: null, stop_details: null,
          id: 'msg_3',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 5, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { signature: '', type: 'thinking', thinking: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'let me think' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig_old' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig_123' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: { citations: null, type: 'text', text: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'answer' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 1 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: 'end_turn' },
        usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 20 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const result = await reassembleAnthropicMessagesEvents(body);

  assertEquals(result.content.length, 2);
  assertEquals(result.content[0].type, 'thinking');
  const thinking = result.content[0] as {
    type: 'thinking';
    thinking: string;
    signature?: string;
  };
  assertEquals(thinking.thinking, 'let me think');
  assertEquals(thinking.signature, 'sig_123');
  assertEquals(result.content[1].type, 'text');
});

test('reassembleAnthropicMessagesEvents reassembles native web search blocks and usage', async () => {
  const body = makeEvents([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          container: null, diagnostics: null, stop_details: null,
          id: 'msg_ws',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, service_tier: null,
            input_tokens: 10,
            output_tokens: 0,
            server_tool_use: { web_search_requests: 0 },
          },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          caller: { type: 'direct' },
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: 'Claude Shannon birth date' },
        },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            {
              type: 'web_search_result',
              url: 'https://example.com/shannon',
              title: 'Claude Shannon',
              encrypted_content: 'eyJjb250ZW50IjpbXX0',
              page_age: '2025-04-30',
            },
          ],
        },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 1 },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 2,
        content_block: { citations: null, type: 'text', text: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'text_delta',
          text: 'Claude Shannon was born in 1916.',
        },
      },
    },
    {
      event: 'content_block_delta', data: {
        type: 'content_block_delta', index: 2, delta: {
          type: 'citations_delta', citation: {
            type: 'web_search_result_location',
            url: 'https://example.com/shannon',
            title: 'Claude Shannon',
            encrypted_index: 'eyJzZWFyY2hfcmVzdWx0X2luZGV4IjowLCJzdGFydF9ibG9ja19pbmRleCI6MCwiZW5kX2Jsb2NrX2luZGV4IjowfQ',
            cited_text: 'Claude Shannon (1916-2001)',
          },
        },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 2 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { container: null, stop_details: null, stop_reason: 'pause_turn', stop_sequence: null },
        usage: {
          input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null,
          output_tokens: 9,
          server_tool_use: { web_search_requests: 1 },
        },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  const result = await reassembleAnthropicMessagesEvents(body);

  assertEquals(result.stop_reason, 'pause_turn');
  assertEquals(result.usage.server_tool_use?.web_search_requests, 1);
  assertEquals(result.content[0].type, 'server_tool_use');
  assertEquals(result.content[1].type, 'web_search_tool_result');
  assertEquals(result.content[2].type, 'text');
  assertEquals((result.content[2] as AnthropicMessagesTextBlock).citations?.[0]?.type, 'web_search_result_location');
});

test('reassembleAnthropicMessagesEvents preserves refusal details, fallback boundaries, and iteration usage', async () => {
  const result = await reassembleAnthropicMessagesEvents(makeEvents([
    {
      data: {
        type: 'message_start',
        message: {
          container: null, diagnostics: null, stop_details: null,
          id: 'msg_refusal',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 5, output_tokens: 0 },
        },
      },
    },
    {
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'fallback',
          from: { model: 'claude-opus-5' },
          to: { model: 'claude-opus-4-8' },
          trigger: { type: 'refusal', category: 'future_policy' },
        },
      },
    },
    { data: { type: 'content_block_stop', index: 0 } },
    {
      data: {
        type: 'message_delta',
        delta: {
          container: null,
          stop_reason: 'refusal',
          stop_details: {
            type: 'refusal',
            category: 'future_policy',
            explanation: null,
            recommended_model: 'claude-opus-4-8',
          },
          stop_sequence: null,
        },
        usage: {
          input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null,
          output_tokens: 0,
          iterations: [{ type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 5, output_tokens: 0 }],
        },
      },
    },
    { data: { type: 'message_stop' } },
  ]));

  assertEquals(result.stop_details, {
    type: 'refusal',
    category: 'future_policy',
    explanation: null,
    recommended_model: 'claude-opus-4-8',
  });
  assertEquals(result.content, [{
    type: 'fallback',
    from: { model: 'claude-opus-5' },
    to: { model: 'claude-opus-4-8' },
    trigger: { type: 'refusal', category: 'future_policy' },
  }]);
  assertEquals(result.usage.iterations, [{ type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 5, output_tokens: 0 }]);
});

test.each([{ content: 'second', encrypted_content: 'opaque' }, { content: null, encrypted_content: null }, { content: 'second' }])('replaces compaction final values and preserves additional standard usage fields: %j', async final => {
  const events = async function* (): AsyncGenerator<AnthropicMessagesStreamEventEx> {
    yield {
      type: 'message_start',
      message: {
        container: null, diagnostics: null, stop_details: null,
        id: 'msg_compaction', type: 'message', role: 'assistant', model: 'claude', content: [],
        stop_reason: null, stop_sequence: null,
        usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, service_tier: null, input_tokens: 1, output_tokens: 0, inference_geo: 'us', server_tool_use: { web_search_requests: 0, web_fetch_requests: 2 } },
      },
    };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: null, encrypted_content: null } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: 'first ', encrypted_content: 'initial cipher' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', ...final } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_stop' };
  };
  const result = await reassembleAnthropicMessagesEvents(events());
  assertEquals(result.content, [{ type: 'compaction', encrypted_content: 'initial cipher', ...final }]);
  assertEquals(result.usage.inference_geo, 'us');
  assertEquals(result.usage.server_tool_use?.web_fetch_requests, 2);
});

test('result reflects all events accepted before each read', () => {
  const accumulator = createAnthropicMessagesEventAccumulator();
  assertEquals(accumulator.contentBlock(3), undefined);
  accumulator.accept({
    type: 'message_start',
    message: {
      id: 'incremental', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, stop_sequence: null, stop_details: null,
      container: null, diagnostics: null,
      usage: {
        input_tokens: 1,
        output_tokens: 0,
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        output_tokens_details: null,
        server_tool_use: null,
        inference_geo: null,
        service_tier: null,
      },
    },
  });
  accumulator.accept({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'hello', citations: null } });

  assertEquals(accumulator.result().content, [{ type: 'text', text: 'hello', citations: null }]);
  accumulator.accept({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } });

  assertEquals(accumulator.result().content, [{ type: 'text', text: 'hello world', citations: null }]);
  assertEquals(accumulator.contentBlock(0), accumulator.result().content[0]);

  const block = { type: 'tool_use' as const, id: 'tool', name: 'lookup', input: {}, vendorText: 'preserved' };
  accumulator.accept({ type: 'content_block_start', index: 3, content_block: block });
  accumulator.accept({ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"large":900719925474099312345,"unfinished":' } });
  accumulator.accept({ type: 'content_block_stop', index: 3 });
  assertEquals(accumulator.contentBlock(1), undefined);
  const tool = accumulator.contentBlock(3);
  assert(tool?.type === 'tool_use');
  assertEquals(JSON.stringify(tool.input), '{"large":900719925474099312345}');
  assertEquals(Object.keys(tool).sort(), ['id', 'input', 'name', 'type', 'vendorText']);
  assertEquals(tool, accumulator.result().content[1]);
});
