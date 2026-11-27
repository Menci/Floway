import { expect, test, vi } from 'vitest';

import { openaiResponsesHttpEntry } from '../../../../../src/data-plane/chat/pipeline/index.ts';
import { expandShimCompactionItems, SUMMARY_PREFIX } from '../../../../../src/data-plane/non-chat/openai-responses-compact/compaction.ts';
import { openaiResponsesCompactIngress } from '../../../../../src/data-plane/non-chat/openai-responses-compact/pipeline.ts';
import { encodeBase64UrlJson } from '../../../../../src/shared/base64url-json.ts';
import { customCandidate, jsonBody, operationHost, requestFor } from '../../../non-chat/count-tokens/fixtures.ts';
import type { Fetcher } from '@floway-dev/http';
import { run } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const candidate = customCandidate('compact', { openaiResponses: {} });

const summary = (text: string, status = 'completed') => {
  const event = {
    type: `response.${status}`,
    response: {
      id: 'upstream', object: 'response', status, model: 'wire-model',
      output: [{ type: 'message', role: 'assistant', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage, error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};

test('keeps opaque compaction items and expands gateway-owned history on an ordinary generation request', async () => {
  const opaque = { type: 'compaction' as const, id: 'cmp_opaque', encrypted_content: 'OPAQUE_NATIVE_BLOB' };
  const recovered = { type: 'message' as const, role: 'user' as const, content: 'RECOVERED SUMMARY' };
  const original: CanonicalOpenAIResponsesPayload = { model: 'public-model', input: [opaque] };
  expect(expandShimCompactionItems(original)).toBe(original);
  const fetcher = vi.fn<Fetcher>(async (_url, init) => {
    expect(JSON.parse(String(init.body))).toMatchObject({ input: [opaque, recovered, { type: 'message', role: 'user', content: 'continue' }] });
    return summary('done');
  });
  const host = operationHost([candidate], fetcher);
  const execution = run(openaiResponsesHttpEntry, requestFor('/v1/responses', {
    model: 'public-model', store: false,
    input: [opaque, { type: 'compaction', id: 'cmp_known', encrypted_content: encodeBase64UrlJson([recovered]) }, { type: 'message', role: 'user', content: 'continue' }],
  }), host.options);
  const answer = await execution.result;
  expect(answer.http?.status).toBe(200);
  expect(fetcher).toHaveBeenCalledOnce();
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
});

test('replays each native compact item independently and preserves their positions and usage', async () => {
  const first = { type: 'compaction', id: 'cmp_1', encrypted_content: 'OPAQUE_1' };
  const second = { type: 'compaction_summary', id: 'cmp_2', encrypted_content: 'OPAQUE_2' };
  const middle = { type: 'message', id: 'msg_middle', role: 'user', status: 'completed', content: [{ type: 'input_text', text: 'middle' }] };
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    const request = JSON.parse(String(init.body));
    if (new URL(url).pathname === '/v1/responses/compact') return Response.json({
      id: 'native-compact', object: 'response.compaction', output: [first, middle, second], usage,
    });
    expect(request.store).toBe(false);
    expect(request.tools).toBeUndefined();
    expect(request.instructions).toBeUndefined();
    expect(request.input).toHaveLength(3);
    const source = request.input[1];
    expect([first, second]).toContainEqual(source);
    return summary(source.id === first.id ? 'first summary' : 'second summary');
  });
  const host = operationHost([{
    ...candidate, model: { ...candidate.model, enabledFlags: ['openai-responses-compact-decrypt'] },
  }], fetcher);
  const execution = run(openaiResponsesCompactIngress, requestFor('/v1/responses/compact', {
    model: 'public-model', input: 'compact me', store: false, instructions: 'caller instructions',
  }), host.options);
  const answer = await execution.result;
  expect(answer.http?.status).toBe(200);
  expect(jsonBody(answer.http)).toMatchObject({
    output: [
      expect.objectContaining({ type: 'reasoning', encrypted_content: expect.any(String) }),
      { ...first, encrypted_content: encodeBase64UrlJson([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first summary' }] }]) },
      middle,
      { ...second, encrypted_content: encodeBase64UrlJson([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second summary' }] }]) },
    ],
    usage: { input_tokens: 30, output_tokens: 6, total_tokens: 36 },
  });
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(host.recordUsage).toHaveBeenCalledTimes(3);
  expect(host.errors).toEqual([]);
});

test('simulated compact appends a cache-sharing user prompt and preserves incomplete status', async () => {
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(new URL(url).pathname).toBe('/v1/responses');
    const request = JSON.parse(String(init.body));
    expect(request.store).toBe(false);
    expect(request.input[0]).toMatchObject({ type: 'message', role: 'user', content: 'keep this' });
    expect(request.input.at(-1)).toMatchObject({ type: 'message', role: 'user' });
    expect(request.input).toHaveLength(2);
    return summary('handoff', 'incomplete');
  });
  const host = operationHost([{
    ...candidate, model: { ...candidate.model, enabledFlags: ['openai-responses-compact-shim'] },
  }], fetcher);
  const execution = run(openaiResponsesCompactIngress, requestFor('/v1/responses/compact', {
    model: 'public-model', input: 'keep this', store: false,
  }), host.options);
  const answer = await execution.result;
  expect(answer.http?.status).toBe(200);
  expect(jsonBody(answer.http)).toMatchObject({
    object: 'response.compaction', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output: expect.arrayContaining([expect.objectContaining({
      type: 'compaction', encrypted_content: encodeBase64UrlJson([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `${SUMMARY_PREFIX}\nhandoff` }] }]),
    })]),
  });
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(host.errors).toEqual([]);
});
