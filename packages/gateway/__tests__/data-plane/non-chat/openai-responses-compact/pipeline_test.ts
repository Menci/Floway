import { expect, test, vi } from 'vitest';

import { SUMMARY_PREFIX } from '../../../../src/data-plane/non-chat/openai-responses-compact/compaction.ts';
import { openaiResponsesCompactIngress } from '../../../../src/data-plane/non-chat/openai-responses-compact/pipeline.ts';
import { customCandidate, jsonBody, operationHost, requestFor } from '../count-tokens/fixtures.ts';
import { getHeader, type FetchInit } from '@floway-dev/http';
import { run } from '@floway-dev/pipeline';

const usage = { input_tokens: 12, output_tokens: 3, total_tokens: 15 };
const upstream = customCandidate('compact', { openaiResponses: {} });
const post = (body: Record<string, unknown> = {}) => requestFor('/v1/responses/compact', {
  model: 'public-model', input: 'keep this', store: false, ...body,
});

test('encodes a native compact resource and stores the candidate usage once', async () => {
  const fetcher = vi.fn(async (url: string, init: FetchInit) => {
    expect(new URL(url).pathname).toBe('/v1/responses/compact');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'wire-model', input: [{ role: 'user', type: 'message', content: 'keep this' }],
    });
    return Response.json({
      id: 'upstream-response', object: 'response.compaction', usage,
      output: [{ type: 'compaction', id: 'cmp_native', encrypted_content: 'provider-content' }],
    }, {
      headers: { 'request-id': 'compacted' },
    });
  });
  const host = operationHost([upstream], fetcher);
  const running = run(openaiResponsesCompactIngress, post({ temperature: 0.4 }), host.options);
  const answer = await running.result;
  expect(answer.candidate).toEqual({ upstreamId: 'compact', model: 'public-model' });
  expect(answer.http?.status).toBe(200);
  expect(getHeader(answer.http?.headers ?? [], 'request-id')).toBe('compacted');
  expect(jsonBody(answer.http)).toMatchObject({
    object: 'response.compaction', created_at: 1_750_000_000, output: [{ type: 'compaction', id: 'cmp_native' }],
    usage: { ...usage, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(host.recordUsage).toHaveBeenCalledTimes(1);
  expect(host.recordPerformance).toHaveBeenCalledTimes(1);
  expect(host.errors).toEqual([]);
});

test('retries an empty summary and settles both generation calls', async () => {
  const candidate = { ...upstream, model: { ...upstream.model, enabledFlags: ['openai-responses-compact-shim'] as const } };
  let attempt = 0;
  const fetcher = vi.fn(async (url: string, init: FetchInit) => {
    expect(new URL(url).pathname).toBe('/v1/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'wire-model', stream: true, store: false });
    const output = ++attempt === 1 ? [] : [{
      type: 'message', role: 'assistant', id: 'msg_1', status: 'completed',
      content: [{ type: 'output_text', text: 'Handoff summary', annotations: [] }],
    }];
    const event = {
      type: 'response.completed',
      response: { id: 'response', object: 'response', status: 'completed', model: 'wire-model', output, usage },
    };
    return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  const host = operationHost([candidate], fetcher);
  const running = run(openaiResponsesCompactIngress, post(), host.options);
  const answer = await running.result;
  expect(answer.http?.status).toBe(200);
  const body = jsonBody(answer.http) as { output: { type: string; encrypted_content: string }[] };
  expect(body).toMatchObject({
    object: 'response.compaction', output: [{ type: 'reasoning' }, { type: 'compaction' }],
    usage: { input_tokens: 24, output_tokens: 6, total_tokens: 30 },
  });
  const compaction = body.output.find(item => item.type === 'compaction');
  if (compaction === undefined) throw new Error('Expected the compaction item');
  const summary = Buffer.from(compaction.encrypted_content, 'base64url').toString('utf8');
  expect(JSON.parse(summary)).toMatchObject([{ content: [{ text: `${SUMMARY_PREFIX}\nHandoff summary` }] }]);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(host.recordUsage).toHaveBeenCalledTimes(2);
  expect(host.recordPerformance).toHaveBeenCalledTimes(2);
  expect(host.errors).toEqual([]);
});
