import { expect, test } from 'vitest';

import { stubResponsesProviderPipeline } from './provider-pipeline.ts';
import { openaiResponsesAttemptPipeline } from '../../../../src/data-plane/chat/openai-responses/attempt-pipeline.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatPipelineServices, stubRouteCandidate } from '../../../test-utils/chat-pipeline.ts';
import { runPipeline } from '@floway-dev/pipeline';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';

const result: import('@floway-dev/protocols/openai-responses').OpenAIResponsesResultEx = { id: 'r', object: 'response', model: 'wire', status: 'completed', output: [], error: null, incomplete_details: null, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };

test('native generation dispatches the candidate wire model and folds usage into the ledger', async () => {
  initRepo(new InMemoryRepo());
  let body: unknown;
  const provider = stubResponsesProviderPipeline('provider.responses', async (facts, env) => {
    body = facts['request.payload'];
    return {
      action: 'generate', ok: true, modelKey: 'wire',
      events: env.createStream({
        async *iterate() {
          yield eventFrame({ type: 'response.created', sequence_number: 0, response: { ...result, status: 'in_progress' } });
          yield eventFrame({ type: 'response.completed', sequence_number: 1, response: result });
          yield doneFrame();
        },
      }),
      http: { status: 200, statusText: 'OK', headers: [], timing: { startedAtMs: 1, headersAtMs: 2 } },
    };
  });
  const candidate = stubRouteCandidate({ modelId: 'public', upstreamModelId: 'wire', endpoints: { openaiResponses: {} } });
  const { services } = mockChatPipelineServices({ entries: [{ candidate, pipelines: { openaiResponses: provider } }] });
  const outcome = await runPipeline(openaiResponsesAttemptPipeline, {
    'route.candidate': candidate, 'request.inboundHeaders': [],
    'request.payload': { model: 'public', input: [{ type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'prior' }] }] },
    'request.action': 'generate',
  }, { services });
  expect(body).toMatchObject({ input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'prior' }] }] });
  expect(body).not.toHaveProperty('model');
  expect(outcome.type).toBe('events');
  if (outcome.type !== 'events') throw new Error('expected events');
  for await (const _frame of outcome.events) { /* drain */ }
  expect(services.usageLedger.read(outcome.usageId, outcome).billableUsage).toEqual({ input: 3, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 2 });
});

test('native compact drops stream/store and synthesizes a compaction stream from the JSON outcome', async () => {
  initRepo(new InMemoryRepo());
  let body: Record<string, unknown> | undefined;
  const provider = stubResponsesProviderPipeline('provider.responses', async facts => {
    body = facts['request.payload'] as unknown as Record<string, unknown>;
    return {
      action: 'compact', ok: true, modelKey: 'wire',
      result: { id: 'r', object: 'response.compaction', model: 'wire', status: 'completed', output: [{ type: 'compaction', id: 'cmp', encrypted_content: 'opaque' }], error: null, incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      http: { status: 200, statusText: 'OK', headers: [], timing: { startedAtMs: 1, headersAtMs: 2 } },
    } as never;
  });
  const candidate = stubRouteCandidate({ modelId: 'public', upstreamModelId: 'wire', endpoints: { openaiResponses: {} } });
  const { services } = mockChatPipelineServices({ entries: [{ candidate, pipelines: { openaiResponses: provider } }] });
  const outcome = await runPipeline(openaiResponsesAttemptPipeline, {
    'route.candidate': candidate, 'request.inboundHeaders': [],
    'request.payload': { model: 'public', input: [], stream: true, store: true }, 'request.action': 'compact',
  }, { services });
  expect(body).not.toHaveProperty('stream');
  expect(body).not.toHaveProperty('store');
  expect(outcome.type).toBe('events');
  if (outcome.type === 'events') for await (const _frame of outcome.events) { /* drain */ }
});
