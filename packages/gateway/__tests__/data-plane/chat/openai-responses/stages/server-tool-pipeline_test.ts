import { expect, test } from 'vitest';

import { openaiResponsesAttemptPipeline } from '../../../../../src/data-plane/chat/openai-responses/attempt-pipeline.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { mockChatPipelineServices, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import { stubResponsesProviderPipeline } from '../provider-pipeline.ts';
import { runPipeline } from '@floway-dev/pipeline';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

const response = (text: string): OpenAIResponsesResultEx => ({ id: 'r', object: 'response', model: 'wire', status: 'completed', output: [{ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], error: null, incomplete_details: null });

test('a hosted tool loop executes through a real subrun and records edgeKind subrun', async () => {
  initRepo(new InMemoryRepo());
  const calls: string[] = [];
  const actions: string[] = [];
  const provider = stubResponsesProviderPipeline('provider.responses', async (facts, env) => {
    calls.push(JSON.stringify(facts['request.payload'].input));
    actions.push(facts['request.action']);
    const terminalResponse = response('done');
    if (calls.length > 1) {
      return {
        action: 'generate', ok: true, modelKey: 'wire',
        events: env.createStream({
          async *iterate() {
            yield eventFrame({ type: 'response.created', sequence_number: 0, response: terminalResponse });
            yield eventFrame({ type: 'response.completed', sequence_number: 1, response: terminalResponse });
            yield doneFrame();
          },
        }),
        http: { status: 200, statusText: 'OK', headers: [], timing: { startedAtMs: 1, headersAtMs: 2 } },
      };
    }
    const call = { type: 'function_call' as const, id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{"search_query":[{"q":"pipeline trace"}]}', status: 'completed' as const };
    return {
      action: 'generate', ok: true, modelKey: 'wire',
      events: env.createStream({
        async *iterate() {
          yield eventFrame({ type: 'response.created', sequence_number: 0, response: { ...response(''), status: 'in_progress' } });
          yield eventFrame({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...call, status: 'in_progress' } });
          yield eventFrame({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: call });
          yield eventFrame({ type: 'response.completed', sequence_number: 3, response: { ...response(''), output: [call] } });
          yield doneFrame();
        },
      }),
      http: { status: 200, statusText: 'OK', headers: [], timing: { startedAtMs: 1, headersAtMs: 2 } },
    };
  });
  const candidate = stubRouteCandidate({ modelId: 'public', upstreamModelId: 'wire', endpoints: { openaiResponses: {} }, enabledFlags: ['openai-responses-web-search-shim'] });
  const { services } = mockChatPipelineServices({
    entries: [{ candidate, pipelines: { openaiResponses: provider } }],
    webSearchProvider: async () => ({
      type: 'enabled',
      provider: 'tavily',
      impl: {
        search: async () => ({ type: 'ok', results: [{ source: 'https://example.com', title: 'Example', content: [{ type: 'text', text: 'result' }] }] }),
        fetchPage: async () => ({ type: 'ok', pages: [], failures: [] }),
      },
    }),
  });
  const sink = { events: [] as any[] };
  const outer = runPipeline(openaiResponsesAttemptPipeline, {
    'route.candidate': candidate,
    'request.inboundHeaders': [],
    'request.payload': { model: 'public', input: [], tools: [{ type: 'web_search' }], max_tool_calls: 1 },
    'request.action': 'generate',
  }, {
    services,
    traceSink: {
      push: event => sink.events.push(event),
    },
  });
  const outcome = await outer;
  expect(outcome.type).toBe('events');
  if (outcome.type === 'events') {
    const observed: unknown[] = [];
    for await (const frame of outcome.events) {
      if (frame.type === 'event') observed.push(frame.event);
    }
    expect(observed.at(-1)).toMatchObject({ type: 'response.completed' });
  }
  expect(calls.length).toBeGreaterThan(1);
  expect(actions).toEqual(['generate', 'generate']);
  const enters = sink.events.filter(event => event.k === 'enter');
  expect(enters.some(event => event.name === 'agentMessageShim')).toBe(true);
  expect(enters.some(event => event.name === 'serverToolShim')).toBe(true);
  expect(enters.some(event => event.name === 'web-search.local' && event.edgeKind === 'subrun')).toBe(true);
  expect(enters.filter(event => event.name === 'provider.responses.end').length).toBeGreaterThan(1);
});
