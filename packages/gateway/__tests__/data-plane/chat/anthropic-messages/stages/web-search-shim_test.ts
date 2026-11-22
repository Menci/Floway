import { expect, test, vi } from 'vitest';

import { webSearchRequestPrepared, webSearchShim } from '../../../../../src/data-plane/chat/anthropic-messages/stages/web-search-shim.ts';
import {
  decodeWebSearchCitationPayload,
  decodeWebSearchResultPayload,
  encodeWebSearchCitationPayload,
  encodeWebSearchResultPayload,
  prepareAnthropicMessagesWebSearchShimRequest,
} from '../../../../../src/data-plane/chat/anthropic-messages/web-search-shim.ts';
import { createChatPipelineServices, type ChatPipelineServices } from '../../../../../src/data-plane/chat/pipeline/index.ts';
import { providerWebSearchSubPipeline } from '../../../../../src/data-plane/tools/web-search/pipeline.ts';
import type { WebSearchProvider, WebSearchProviderResult } from '../../../../../src/data-plane/tools/web-search/types.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { createManagedProtocolFrames, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { createDumpDecoder, createDumpEncoder, pipeline, runPipeline, terminal } from '@floway-dev/pipeline';
import type { RunTraceSink } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

const evalTrace = (): { readonly sink: RunTraceSink; readonly read: () => ReturnType<ReturnType<typeof createDumpDecoder>['pushNdjsonChunk']> } => {
  const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
  const chunks: Uint8Array[] = [];
  return {
    sink: { push: event => { for (const encoded of encoder.encodeBatch([event])) chunks.push(new TextEncoder().encode(`${JSON.stringify(encoded)}\n`)); } },
    read: () => {
      const decoder = createDumpDecoder();
      const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return decoder.pushNdjsonChunk(bytes, { final: true });
    },
  };
};

const nativeTool = (): AnthropicMessagesPayload => ({
  model: 'claude-test',
  max_tokens: 64,
  tools: [{ name: 'web_search', type: 'web_search_20260209', max_uses: 2 }],
  messages: [{ role: 'user', content: 'latest React docs' }],
});

const activeInputFrames = (): readonly ProtocolFrame<AnthropicMessagesStreamEventEx>[] => [
  eventFrame({
    type: 'message_start',
    message: {
      container: null, diagnostics: null, stop_details: null, id: 'msg_search', type: 'message', role: 'assistant', model: 'claude-test',
      content: [], stop_reason: null, stop_sequence: null,
      usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: 'standard', input_tokens: 4, output_tokens: 0 },
    },
  }),
  eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_search', name: 'web_search', input: {} } }),
  eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"React docs"}' } }),
  eventFrame({ type: 'content_block_stop', index: 0 }),
  eventFrame({ type: 'message_delta', delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: 'tool_use' }, usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 1 } }),
  eventFrame({ type: 'message_stop' }),
];

const searchProvider = (): WebSearchProvider => ({
  async search() {
    return { type: 'ok', results: [{ source: 'https://react.dev', title: 'React', content: [{ type: 'text', text: 'Official React docs' }] }] };
  },
  fetchPage: () => Promise.reject(new Error('unused')),
});

test('web-search payload codecs reject foreign and malformed replay data', () => {
  const result = encodeWebSearchResultPayload({ content: [{ type: 'text', text: 'docs' }] });
  expect(decodeWebSearchResultPayload(result)).toEqual({ content: [{ type: 'text', text: 'docs' }] });
  expect(decodeWebSearchResultPayload('foreign.payload')).toBeNull();
  const citation = encodeWebSearchCitationPayload({ search_result_index: 0, start_block_index: 0, end_block_index: 1 });
  expect(decodeWebSearchCitationPayload(citation)).toEqual({ search_result_index: 0, start_block_index: 0, end_block_index: 1 });
});

test('replay preparation converts our native-looking history back to upstream client-tool history', () => {
  const payload: AnthropicMessagesPayload = {
    model: 'claude-test', max_tokens: 64,
    messages: [
      { role: 'user', content: 'latest docs' },
      {
        role: 'assistant', content: [
          { caller: { type: 'direct' }, type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'latest docs' } },
          { caller: { type: 'direct' }, type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://react.dev', title: 'React', encrypted_content: encodeWebSearchResultPayload({ content: [{ type: 'text', text: 'docs' }] }) }] },
        ],
      },
    ],
  };
  const prepared = prepareAnthropicMessagesWebSearchShimRequest(payload);
  expect(prepared.type).toBe('ok');
  if (prepared.type !== 'ok') throw new Error('expected prepared request');
  expect(prepared.state.mode).toBe('replay_only');
  expect(prepared.payload.messages[1]?.content).toMatchObject([{ type: 'tool_use', name: 'web_search' }]);
  expect(prepared.payload.messages).toHaveLength(3);
});

test('count tokens returns an Anthropic invalid-request body before dispatch', async () => {
  const { outcome } = await runChatStage({
    stage: webSearchRequestPrepared,
    facts: {
      'route.candidate': stubRouteCandidate({ enabledFlags: ['anthropic-messages-web-search-shim'] }),
      'route.targetApi': 'anthropicMessages',
      'request.inboundHeaders': [],
      'request.payload': {
        ...nativeTool(), tools: [
          { name: 'web_search', type: 'web_search_20260209' },
          { name: 'web_search', type: 'web_search_20260209' },
        ],
      },
      'request.anthropicBeta': [],
      'web-search.state': undefined,
    },
    next: () => { throw new Error('must not dispatch'); },
  });
  expect(outcome.type).toBe('plain');
  if (outcome.type !== 'plain') throw new Error('expected plain');
  expect(outcome.http.status).toBe(400);
  expect(JSON.parse(new TextDecoder().decode(outcome.body!))).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
});

test('active hosted searches rewrite to native events and execute provider searches as subruns', async () => {
  initRepo(new InMemoryRepo());
  const trace = evalTrace();
  const ctx = mockChatGatewayCtx({ wantsStream: true });
  const base = createChatPipelineServices(ctx);
  const search = vi.fn(searchProvider().search);
  const services = Object.freeze({
    ...base,
    webSearchProvider: async () => ({ type: 'enabled' as const, provider: 'tavily' as const, impl: { ...searchProvider(), search } }),
  });
  const facts = {
    'route.candidate': stubRouteCandidate({ enabledFlags: ['anthropic-messages-web-search-shim'] }),
    'route.targetApi': 'anthropicMessages' as const,
    'request.inboundHeaders': [],
    'request.payload': nativeTool(),
    'request.anthropicBeta': [],
    'web-search.state': undefined as undefined,
  };
  const { outcome } = await runChatStage({
    stage: webSearchShim,
    facts,
    services,
    traceSink: trace.sink,
    next: (_facts, env) => ({
      type: 'events' as const,
      events: createManagedProtocolFrames(env, activeInputFrames().flatMap(frame => frame.type === 'event' ? [frame.event] : []), { emitDone: false, label: 'anthropic-messages.upstream.events' }),
      modelIdentity: { model: 'claude-test', upstream: 'up_test', modelKey: 'claude-test', pricing: null },
    }),
  });
  expect(outcome.type).toBe('events');
  if (outcome.type !== 'events') throw new Error('expected events');
  const events: AnthropicMessagesStreamEventEx[] = [];
  for await (const frame of outcome.events) if (frame.type === 'event') events.push(frame.event);
  expect(search).toHaveBeenCalledOnce();
  expect(events.some(event => event.type === 'content_block_start' && event.content_block.type === 'server_tool_use')).toBe(true);
  expect(events.some(event => event.type === 'content_block_start'
    && event.content_block.type === 'web_search_tool_result'
    && Array.isArray(event.content_block.content))).toBe(true);
});

test('provider web-search execution records a subrun edge in Dump V2', async () => {
  initRepo(new InMemoryRepo());
  const trace = evalTrace();
  const ctx = mockChatGatewayCtx({ wantsStream: true });
  const base = createChatPipelineServices(ctx);
  const services = Object.freeze({
    ...base,
    webSearchProvider: async () => ({ type: 'enabled' as const, provider: 'tavily' as const, impl: searchProvider() }),
  });
  const host = pipeline<Record<never, never>>('test.web-search.subrun.host').end(terminal<Record<never, never>, WebSearchProviderResult, ChatPipelineServices>({
    name: 'test.web-search.subrun.host.end',
    execute: async (_facts, env) => await env.spawnSubRun(providerWebSearchSubPipeline, { 'web-search.request': { query: 'React docs' } }),
  }));
  const result = await runPipeline(host, {}, { services, traceSink: trace.sink });
  expect(result).toMatchObject({ type: 'ok' });
  const model = trace.read();
  expect([...model.stages.values()].some(stage => stage.edgeKind === 'subrun' && stage.name === 'web-search.provider.end')).toBe(true);
});
