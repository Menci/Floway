import { expect, test, vi } from 'vitest';

import { anthropicMessagesHostedTools } from '../../../../../src/data-plane/chat/anthropic-messages/pipeline/hosted-tools.ts';
import { compose, defineStage } from '../../../../../src/data-plane/chat/pipeline/facts.ts';
import { createGatewayServices } from '../../../../../src/data-plane/pipeline/services.ts';
import type { WebSearchBackend } from '../../../../../src/data-plane/tools/web-search/types.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { candidateFor, hostFor } from '../../../pipeline/fixtures.ts';
import { asEntry, run } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolStreamError } from '@floway-dev/upstream';

test('a checked local search produces native Anthropic server tool output and usage', async () => {
  initRepo(new InMemoryRepo());
  const defaults = createGatewayServices({
    apiKey: { id: 'key', serverSecret: 'ab'.repeat(32), openaiResponsesRetentionSeconds: 0, upstreamIds: null, randomizeUpstreams: false },
    subject: { id: 1, isAdmin: false },
    runtimeLocation: 'TEST',
    dump: null,
  });
  const search = vi.fn<WebSearchBackend['search']>(async () => ({
    type: 'ok',
    results: [{ source: 'https://example.test/article', title: 'Search result', content: [{ type: 'text', text: 'Article content' }] }],
  }));
  const host = hostFor({
    ...defaults,
    localWebSearch: {
      ...defaults.localWebSearch,
      getBackend: async () => ({
        type: 'enabled' as const,
        backend: 'tavily' as const,
        impl: { search, fetchPage: async () => { throw new Error('Unexpected page fetch'); } },
      }),
    },
  });

  let dialPayload: AnthropicMessagesPayload | undefined;
  const emitter = defineStage({
    name: 'script-anthropic-tool-call',
    request: { needs: ['anthropicMessages'] },
    return: { provides: ['http', 'anthropicMessages'] },
    async execute({ anthropicMessages }, scope) {
      dialPayload = anthropicMessages;
      const stream = scope.createStream<AnthropicMessagesStreamEventEx, ProtocolStreamError>(async function* () {
        const events: AnthropicMessagesStreamEventEx[] = [
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_search', name: 'web_search', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"test query"}' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null, container: null, stop_details: null },
            usage: { input_tokens: null, output_tokens: 10, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null },
          },
          { type: 'message_stop' },
        ];
        for (const event of events) yield { ok: true, value: event };
      });
      return { http: null, anthropicMessages: { kind: 'stream', stream } };
    },
  });
  const entry = asEntry(compose('hosted-anthropic-search-test', {
    entry: ['http', 'model', 'chat.target', 'anthropicMessages'],
    exit: ['http', 'anthropicMessages'],
    stages: [anthropicMessagesHostedTools],
    ending: emitter,
  }));
  const { model } = candidateFor('custom');
  const execution = run(entry, {
    http: { url: 'https://floway.test/v1/messages', headers: [], method: 'POST', body: null },
    model,
    'chat.target': 'openaiChatCompletions',
    anthropicMessages: { model: model.id, messages: [], max_tokens: 32, tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
  }, host.options);

  const answer = await execution.result;
  expect(dialPayload?.tools).toEqual([expect.objectContaining({ name: 'web_search', input_schema: expect.any(Object) })]);
  expect(search).not.toHaveBeenCalled();
  const { anthropicMessages: outcome } = answer;
  if (outcome.kind !== 'stream') throw new Error('Expected the hosted Anthropic Messages stream');
  const events: AnthropicMessagesStreamEventEx[] = [];
  try {
    for await (const item of execution.read(outcome.stream)) {
      if (!item.ok) throw item.error.cause;
      events.push(item.value);
    }
  } finally {
    host.controller.abort();
    execution.discard(answer);
    await host.settle();
  }

  expect(search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ query: 'test query', signal: expect.any(AbortSignal) }));
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'content_block_start', content_block: expect.objectContaining({ type: 'server_tool_use', name: 'web_search' }) }),
    expect.objectContaining({ type: 'content_block_start', content_block: expect.objectContaining({ type: 'web_search_tool_result', content: [expect.objectContaining({ type: 'web_search_result', url: 'https://example.test/article' })] }) }),
    expect.objectContaining({ type: 'message_delta', delta: expect.objectContaining({ stop_reason: 'pause_turn' }), usage: expect.objectContaining({ server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } }) }),
  ]));
  expect(events.at(-1)).toEqual({ type: 'message_stop' });
  expect(host.errors).toEqual([]);
});
