import { describe, expect, test, vi } from 'vitest';

import { isReplayableBody, type Fetcher } from '../src/index.ts';
import { exchangeResponse, http, type HttpRequestFacts, type HttpResponseFacts, type HttpServices } from '../src/pipeline.ts';
import { multipartBody, serializeHttpBody, type HttpFile } from '../src/request-content.ts';
import { compose, move, run, secret, setRelease } from '@floway-dev/pipeline';

const request = (overrides: Partial<HttpRequestFacts> = {}): HttpRequestFacts => move({
  'request.http.callId': 17,
  'request.http.url': 'https://upstream.test/route',
  'request.http.method': 'POST',
  'request.http.headers': [['Content-Type', 'application/json']],
  'request.http.body': { message: 'hello' },
  'request.http.encoding': 'json',
  ...overrides,
});

const execute = (facts: HttpRequestFacts, fetcher: Fetcher, wrapUpstreamCall = async <T>(dispatch: () => Promise<T>): Promise<T> => await dispatch()) => {
  const services: HttpServices = {
    httpCall: callId => {
      expect(callId).toBe(17);
      return { fetcher, wrapUpstreamCall, signal: undefined, waitUntil: () => {} };
    },
  };
  return run(compose<HttpRequestFacts, HttpResponseFacts>('httpTest', [http]), facts, services);
};

describe('shared HTTP stage', () => {
  test('multipart quoting and newline encoding match native Fetch for arbitrary field names and empty filenames', async () => {
    const bytes = new Uint8Array([1, 2, 255]);
    const entries = [{ name: 'line\nname', value: 'line\nvalue' }, { name: 'upload', value: { name: '', type: '', bytes } }];
    const form = new FormData();
    form.append(entries[0]!.name, entries[0]!.value as string);
    form.append('upload', new File([bytes], '', { type: '' }));
    const native = new Request('https://upstream.test', { method: 'POST', body: form });
    const boundary = native.headers.get('content-type')!.split('boundary=')[1]!;
    const encoded = serializeHttpBody({ boundary, entries }, 'multipart');
    if (!isReplayableBody(encoded)) throw new Error('expected replayable multipart content');
    const actual = await new Response(encoded.open()).arrayBuffer();
    expect(new Uint8Array(actual)).toEqual(new Uint8Array(await native.arrayBuffer()));
    expect(actual.byteLength).toBe(encoded.contentLength);
  });

  test('forwards secret values, repeated field lines and immutable JSON content, preserving upstream status and body', async () => {
    const item = { content: 'shared nested object' };
    const payload = { input: [item], token: secret('body-secret') };
    const fetcher: Fetcher = async (url, init) => {
      expect(url).toBe('https://upstream.test/route');
      expect(init.headers).toEqual([['authorization', 'Bearer header-secret'], ['x-value', 'one'], ['x-value', 'two']]);
      if (!isReplayableBody(init.body)) throw new Error('expected a replayable JSON request');
      const bytes = await new Response(init.body.open()).arrayBuffer();
      expect(bytes.byteLength).toBe(init.body.contentLength);
      expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ input: [item], token: 'body-secret' });
      expect(payload.input[0]).toBe(item);
      return new Response('created', { status: 201, statusText: 'Created', headers: { 'x-upstream': 'retained' } });
    };
    const result = await execute(request({
      'request.http.headers': [['authorization', secret('Bearer header-secret')], ['x-value', 'one'], ['x-value', 'two']],
      'request.http.body': payload,
    }), fetcher);
    const exchange = result.facts['response.http.exchange'];
    if (exchange.type !== 'response') throw new Error('expected upstream response');
    expect(result.facts['response.http.body']).toBe(exchange.body);
    expect(exchange.status).toBe(201);
    expect(exchange.headers).toContainEqual(['x-upstream', 'retained']);
    expect(await exchangeResponse(exchange).text()).toBe('created');
    if (exchange.body !== null) setRelease(exchange.body, async () => {});
    await result.drain();
  });

  test('multipart request content retains file bytes, names, media type and repeated fields without native file facts', async () => {
    const file: HttpFile = { name: 'voice.wav', type: 'audio/wav', bytes: new Uint8Array([0, 1, 2, 255]), lastModified: 42 };
    const body = multipartBody([{ name: 'file', value: file }, { name: 'timestamp[]', value: 'word' }, { name: 'timestamp[]', value: 'segment' }]);
    const result = await execute(request({
      'request.http.headers': [['Content-Type', `multipart/form-data; boundary=${body.boundary}`]],
      'request.http.body': body,
      'request.http.encoding': 'multipart',
    }), async (_url, init) => {
      if (!isReplayableBody(init.body)) throw new Error('expected replayable multipart content');
      const response = new Response(init.body.open(), { headers: init.headers });
      const form = await response.formData();
      const uploaded = form.get('file') as File;
      expect(uploaded.name).toBe('voice.wav');
      expect(uploaded.type).toBe('audio/wav');
      expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(file.bytes);
      expect(form.getAll('timestamp[]')).toEqual(['word', 'segment']);
      return new Response(null, { status: 204 });
    });
    expect(result.facts['response.http.body']).toBeNull();
    await result.drain();
  });

  test('represents actual transport rejection as a value retaining the original error chain', async () => {
    const cause = new Error('socket closed');
    const error = new TypeError('fetch failed', { cause });
    const result = await execute(request(), async () => { throw error; });
    expect(result.facts['response.http.exchange']).toEqual({ type: 'transportFailure', error });
    expect(result.facts['response.http.body']).toBeNull();
    await result.drain();
  });

  test('serialization and timing-wrapper faults propagate as programming errors', async () => {
    const fetcher = vi.fn<Fetcher>();
    await expect(execute(request({ 'request.http.body': { count: 1n } }), fetcher)).rejects.toThrow();
    const error = new Error('timing wrapper fault');
    await expect(execute(request(), fetcher, async () => { throw error; })).rejects.toBe(error);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('owns an unread response body immediately and permits the decoder to replace its release action once', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const result = await execute(request(), async () => new Response(body));
    const owned = result.facts['response.http.body'];
    if (owned === null) throw new Error('expected owned body');
    const finish = vi.fn(async () => { await owned.cancel(); });
    setRelease(owned, finish);
    await result.drain();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
