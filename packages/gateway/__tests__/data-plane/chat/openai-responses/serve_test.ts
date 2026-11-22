import { expect, test } from 'vitest';

import { stubResponsesProviderPipeline } from './provider-pipeline.ts';
import { openaiResponsesGeneratePipeline } from '../../../../src/data-plane/chat/openai-responses/serve.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatPipelineServices, stubRouteCandidate } from '../../../test-utils/chat-pipeline.ts';
import { runPipeline } from '@floway-dev/pipeline';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';

const result: import('@floway-dev/protocols/openai-responses').OpenAIResponsesResultEx = { id: 'r', object: 'response', model: 'wire', status: 'completed', output: [], error: null, incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };

test('serve selects a Responses-capable candidate and renders a non-streaming response', async () => {
  initRepo(new InMemoryRepo());
  let calls = 0;
  const provider = stubResponsesProviderPipeline('provider.responses', async (_facts, env) => {
    calls += 1;
    return { action: 'generate', ok: true, modelKey: 'wire', events: env.createStream({ async *iterate() { yield eventFrame({ type: 'response.completed', sequence_number: 0, response: result }); yield doneFrame(); } }), http: { status: 200, statusText: 'OK', headers: [], timing: { startedAtMs: 1, headersAtMs: 2 } } };
  });
  const capable = stubRouteCandidate({ modelId: 'public', upstreamModelId: 'wire', endpoints: { openaiResponses: {} } });
  const { services } = mockChatPipelineServices({ ctxOverrides: { wantsStream: false }, entries: [{ candidate: capable, pipelines: { openaiResponses: provider } }] });
  const outcome = await runPipeline(openaiResponsesGeneratePipeline, {
    'request.http': { method: 'POST', url: 'https://gateway.test/v1/responses', headers: [], body: { kind: 'json', value: {} } },
    'request.inboundHeaders': [], 'request.payload': { model: 'public', input: [] }, 'request.action': 'generate', 'request.wantsStream': false,
  }, { services });
  expect(outcome.status).toBe(200);
  expect(calls).toBe(1);
});

test('serve renders an unknown model as an OpenAI 404 without calling a provider', async () => {
  initRepo(new InMemoryRepo());
  const { services } = mockChatPipelineServices({ sawModel: false, entries: [] });
  const outcome = await runPipeline(openaiResponsesGeneratePipeline, {
    'request.http': { method: 'POST', url: 'https://gateway.test/v1/responses', headers: [], body: { kind: 'json', value: {} } },
    'request.inboundHeaders': [], 'request.payload': { model: 'missing', input: [] }, 'request.action': 'generate', 'request.wantsStream': false,
  }, { services });
  expect(outcome.status).toBe(404);
  expect(JSON.parse(new TextDecoder().decode(outcome.body as Uint8Array))).toMatchObject({ error: { type: 'invalid_request_error' } });
});
