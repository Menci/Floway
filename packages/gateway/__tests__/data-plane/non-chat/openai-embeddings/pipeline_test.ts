import { expect, test } from 'vitest';

import { openaiEmbeddingsIngress } from '../../../../src/data-plane/non-chat/openai-embeddings/index.ts';
import { bodyBytes, mediaCandidate, mediaHost, mediaRequest } from '../openai-audio/media-fixture.ts';
import { getHeader } from '@floway-dev/http';
import { run } from '@floway-dev/pipeline';

test('embeddings only dials enabled endpoints and meters the observed failure and success separately', async () => {
  const failed = mediaCandidate('failed', 'embedding', { openaiEmbeddings: {} });
  const served = mediaCandidate('served', 'embedding', { openaiEmbeddings: {} });
  const omitted = mediaCandidate('disabled', 'embedding', {});
  const attempts = new Map<string, AbortSignal>();
  const host = mediaHost([omitted, failed, served], id => async (url, init) => {
    expect(new URL(url).pathname).toBe('/v1/embeddings');
    if (typeof init.body !== 'string' || init.signal == null) throw new TypeError('Expected JSON request with a signal');
    expect(JSON.parse(init.body)).toEqual({ model: 'wire-model', input: 'example', dimensions: 2 });
    attempts.set(id, init.signal);
    if (id === 'failed') return new Response('retry upstream', { status: 400 });
    return Response.json({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 4 } }, { headers: { 'x-upstream-trace': id } });
  });
  const request = await mediaRequest('/embeddings', { model: 'public-model', input: 'example', dimensions: 2 });
  const execution = run(openaiEmbeddingsIngress, request, host.options);
  const answer = await execution.result;
  expect([...attempts.keys()]).toEqual(['failed', 'served']);
  expect(host.catalogCandidates).toHaveBeenCalledWith({ model: 'public-model', kind: 'embedding' });
  expect(answer.candidate?.upstreamId).toBe('served');
  expect(answer.http?.status).toBe(200);
  expect(getHeader(answer.http!.headers, 'x-upstream-trace')).toBe('served');
  expect(JSON.parse(new TextDecoder().decode(bodyBytes(answer.http)))).toEqual({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 4 } });
  await expect(execution.read(answer.usage!)).resolves.toMatchObject({ kind: 'observed', usage: [{ quantities: { input_tokens: '4' } }] });
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(host.recordPerformance.mock.calls.map(([entry]) => [entry.upstream, entry.failed])).toEqual([['failed', true], ['served', false]]);
  expect(host.recordUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ upstream: 'served' }), expect.objectContaining({ reported: true }));
  expect(host.errors).toEqual([]);
});

test('embeddings preserves upstream JSON errors, renders text errors, and surfaces malformed success', async () => {
  const cases = [
    { status: 429, body: '{"error":{"detail":"vendor-declared"}}', rendered: { error: { detail: 'vendor-declared' } } },
    { status: 503, body: 'provider is unavailable', rendered: { error: { message: 'provider is unavailable' } } },
    { status: 200, body: '[' },
  ];
  for (const { status, body, rendered } of cases) {
    const host = mediaHost([mediaCandidate('embed', 'embedding', { openaiEmbeddings: {} })], () => async () =>
      new Response(body, { status, headers: { 'content-type': 'text/plain', 'x-request-id': 'vendor-request' } }));
    const execution = run(openaiEmbeddingsIngress, await mediaRequest('/embeddings', { model: 'public-model', input: 'example' }), host.options);
    const answer = await execution.result;
    expect(answer.http?.status).toBe(status === 200 ? 502 : status);
    expect(getHeader(answer.http!.headers, 'x-request-id')).toBe('vendor-request');
    expect(getHeader(answer.http!.headers, 'content-type')).toBe('application/json');
    const json: unknown = JSON.parse(new TextDecoder().decode(bodyBytes(answer.http)));
    if (rendered !== undefined) expect(json).toMatchObject(rendered);
    else expect(json).toMatchObject({ error: { message: expect.any(String) } });
    await expect(execution.read(answer.usage!)).resolves.toEqual({ kind: 'upstream-error' });
    host.controller.abort();
    execution.discard(answer);
    await host.settle();
    expect(host.recordPerformance).toHaveBeenCalledWith(expect.objectContaining({ failed: true }));
    expect(host.recordUsage).not.toHaveBeenCalled();
    expect(host.errors).toEqual([]);
  }
});

test('an embeddings provider panic reaches the host and stops failover', async () => {
  const panic = new TypeError('unexpected provider failure');
  const attempts: string[] = [];
  const candidates = ['failed', 'panic', 'undialed'].map(id => mediaCandidate(id, 'embedding', { openaiEmbeddings: {} }));
  const host = mediaHost(candidates, id => async () => {
    attempts.push(id);
    if (id === 'failed') return new Response('ordinary upstream failure', { status: 400 });
    throw panic;
  });
  const request = await mediaRequest('/embeddings', { model: 'public-model', input: 'example' });
  const execution = run(openaiEmbeddingsIngress, request, host.options);
  await expect(execution.result).rejects.toBe(panic);
  host.controller.abort();
  await host.settle();
  expect(attempts).toEqual(['failed', 'panic']);
  expect(host.recordPerformance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ upstream: 'failed', failed: true }));
  expect(host.recordUsage).not.toHaveBeenCalled();
  expect(host.errors).toEqual([]);
});
