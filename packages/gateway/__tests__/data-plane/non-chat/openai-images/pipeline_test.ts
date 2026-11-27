import { expect, test } from 'vitest';

import { openaiImagesEditsIngress, openaiImagesEditsOperation, openaiImagesGenerationsIngress, openaiImagesGenerationsOperation } from '../../../../src/data-plane/non-chat/openai-images/index.ts';
import { bodyBytes, bodyStream, mediaCandidate, mediaHost, mediaRequest, multipartBody, upload } from '../openai-audio/media-fixture.ts';
import { run } from '@floway-dev/pipeline';

test('image edit parses multipart bytes and the independent operation serves the same protocol payload', async () => {
  const image = Uint8Array.of(1, 0, 21, 255);
  const form = new FormData();
  form.append('image[]', new File([image], 'source.png', { type: 'image/png' }));
  form.append('model', 'public-model');
  form.append('prompt', 'Add a cloud');
  const result = { data: [{ b64_json: 'AQAV/w==' }] };
  const host = mediaHost([mediaCandidate('image', 'image', { openaiImagesEdits: {} })], () => async (url, init) => {
    expect(new URL(url).pathname).toBe('/v1/images/edits');
    const body = await multipartBody(init);
    expect(body.get('prompt')).toBe('Add a cloud');
    expect(body.get('model')).toBe('wire-model');
    const file = upload(body.get('image'));
    expect({ name: file.name, type: file.type }).toEqual({ name: 'source.png', type: 'image/png' });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(image);
    return Response.json(result);
  });

  const request = await mediaRequest('/images/edits', form);
  const http = run(openaiImagesEditsIngress, request, host.options);
  const rendered = await http.result;
  expect(JSON.parse(new TextDecoder().decode(bodyBytes(rendered.http)))).toEqual(result);
  http.discard(rendered);

  const operation = run(openaiImagesEditsOperation, {
    ...request,
    requestedModel: 'public-model',
    openaiImagesEdits: {
      images: [{ type: 'upload', file: { name: 'source.png', mediaType: 'image/png', bytes: image } }],
      parameters: { prompt: 'Add a cloud' },
    },
  }, host.options);
  const parsed = await operation.result;
  expect(parsed.http).toMatchObject({ status: 200, body: null });
  expect(parsed.openaiImagesEdits).toEqual({ kind: 'result', result });
  expect(parsed.candidate).toEqual({ upstreamId: 'image', model: 'public-model' });
  host.controller.abort();
  operation.discard(parsed);
  await host.settle();
  expect(host.recordPerformance.mock.calls).toHaveLength(2);
  expect(host.recordUsage.mock.calls).toHaveLength(2);
  expect(host.errors).toEqual([]);
});

test('image generation forwards open payload fields for HTTP and independent callers', async () => {
  const payload = { model: 'public-model', prompt: 'A dark sky', extra: { seed: 1 } };
  const result = { data: [{ b64_json: 'AQAV/w==' }], usage: { input_tokens: 2, output_tokens: 6 } };
  const host = mediaHost([mediaCandidate('image', 'image', { openaiImagesGenerations: {} })], () => async (url, init) => {
    expect(new URL(url).pathname).toBe('/v1/images/generations');
    if (typeof init.body !== 'string') throw new TypeError('Expected image generation JSON');
    expect(JSON.parse(init.body)).toEqual({ ...payload, model: 'wire-model' });
    return Response.json(result);
  });
  const request = await mediaRequest('/images/generations', payload);
  const http = run(openaiImagesGenerationsIngress, request, host.options);
  const rendered = await http.result;
  expect(JSON.parse(new TextDecoder().decode(bodyBytes(rendered.http)))).toEqual(result);
  http.discard(rendered);
  const execution = run(openaiImagesGenerationsOperation, { ...request, openaiImagesGenerations: payload }, host.options);
  const answer = await execution.result;
  expect(answer.openaiImagesGenerations).toEqual({ kind: 'result', result });
  await expect(execution.read(answer.usage!)).resolves.toMatchObject({ kind: 'observed', usage: [{ quantities: { input_tokens: '2', output_tokens: '6' } }] });
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(host.recordUsage.mock.calls).toHaveLength(2);
  expect(host.errors).toEqual([]);
});

test('image generation preserves named SSE and observes usage on its data', async () => {
  const completed = 'event: image_generation.completed\ndata: {"b64_json":"AQAV/w==","usage":{"input_tokens":2,"output_tokens":6}}\n\n';
  const host = mediaHost([mediaCandidate('image', 'image', { openaiImagesGenerations: {} })], () => async () =>
    new Response(completed, { headers: { 'content-type': 'text/event-stream' } }));
  const execution = run(openaiImagesGenerationsIngress, await mediaRequest('/images/generations', {
    model: 'public-model', prompt: 'A dark sky', stream: true,
  }), host.options);
  const answer = await execution.result;
  const reader = execution.read(bodyStream(answer.http));
  await expect(reader.next()).resolves.toEqual({ done: false, value: { ok: true, value: new TextEncoder().encode(completed) } });
  await expect(reader.next()).resolves.toMatchObject({ done: true });
  await expect(execution.read(answer.usage!)).resolves.toMatchObject({ kind: 'observed', usage: [{ quantities: { input_tokens: '2', output_tokens: '6' } }] });
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(host.recordPerformance).toHaveBeenCalledWith(expect.objectContaining({ operation: 'image_generation', failed: false }));
  expect(host.recordUsage).toHaveBeenCalledOnce();
  expect(host.errors).toEqual([]);
});
