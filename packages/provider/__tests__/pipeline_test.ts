import { describe, expect, test } from 'vitest';

import { frozenJsonRequestBody } from '../src/json-request.ts';
import { isReplayableBody } from '../src/options.ts';
import type { FetchInit } from '../src/options.ts';
import {
  buildAudioTranscriptionMultipartBody,
  bytesToManagedStream,
  hasEnabledFlag,
  buildImagesEditsHttpBody,
  buildWireHttpUrl,
  headersFromEntries,
  httpTerminal,
  materializeHeaderLines,
  materializeWireUrl,
  parseUpstreamSseOutcome,
  readManagedBytes,
  syntheticJsonOutcome,
  toProviderModelFacts,
  wrapSensitiveHeaderEntries,
} from '../src/pipeline.ts';
import type { ProviderPipelineServices, UpstreamHttpRequest } from '../src/pipeline.ts';
import {
  createDumpEncoder,
  createDumpDecoder,
  formatCurlCommand,
  isSecret,
  pipeline,
  projectWireView,
  runPipeline,
  secret,
  StreamLeakError,
  terminal,
} from '@floway-dev/pipeline';
import type { ManagedStream, RunTraceSink } from '@floway-dev/pipeline';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { jsonInteger } from '@floway-dev/protocols/common';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const services = (fetcher: (url: string, init: FetchInit) => Promise<Response>, onDispatch?: (info: {
  readonly upstreamId: string;
  readonly startedAtMs: number;
  readonly headersAtMs?: number;
}) => void): ProviderPipelineServices => ({
  fetcherFor: () => fetcher,
  ...(onDispatch === undefined ? {} : { onUpstreamDispatch: onDispatch }),
});

const pipelineFor = (upstreamId: string) =>
  pipeline<{ readonly 'request.http': UpstreamHttpRequest }>(upstreamId).end(httpTerminal(upstreamId));

const executeHttp = async (
  request: UpstreamHttpRequest,
  fetcher: (url: string, init: FetchInit) => Promise<Response>,
  onDispatch?: Parameters<typeof services>[1],
) => await runPipeline(pipelineFor('upstream'), { 'request.http': request }, {
  services: services(fetcher, onDispatch),
});

const bodyText = async (body: ReturnType<typeof frozenJsonRequestBody>): Promise<string> =>
  await new Response(body.open()).text();

describe('frozenJsonRequestBody', () => {
  test('keeps exact serialized lengths and replays frozen data without cloning', async () => {
    const rawJSON = JSON as typeof JSON & { rawJSON: (text: string) => unknown };
    const value = Object.freeze({
      exponent: Object.freeze({ value: 1e21 }),
      largeInteger: Object.freeze({ value: jsonInteger(9_007_199_254_740_993n) }),
      raw: rawJSON.rawJSON('900719925474099312345'),
    });
    const expected = JSON.stringify(value);
    const body = frozenJsonRequestBody(value);

    expect(body.contentLength).toBe(encoder.encode(expected).byteLength);
    expect(await bodyText(body)).toBe(expected);
    expect(await bodyText(body)).toBe(expected);
    expect(value.raw).not.toBe(JSON.parse('null'));
    expect((value.raw as { readonly rawJSON: string }).rawJSON).toBe('900719925474099312345');
  });
});

describe('wire helpers', () => {
  test('reveals secret URL values only during materialization and preserves query order', () => {
    const apiKey = secret('sk/query secret');
    expect(materializeWireUrl({
      origin: 'https://upstream.example',
      pathname: '/v1/chat',
      query: [['key', apiKey], ['alt', 'sse']],
    })).toBe('https://upstream.example/v1/chat?key=sk%2Fquery%20secret&alt=sse');
    expect(materializeWireUrl('https://upstream.example/already?key=raw')).toBe('https://upstream.example/already?key=raw');
  });

  test('wraps sensitive plaintext headers while preserving already-secret and ordinary entries', () => {
    const existing = secret('existing-bearer');
    const entries = wrapSensitiveHeaderEntries([
      ['Authorization', 'Bearer plain'],
      ['x-api-key', existing],
      ['content-type', 'text/event-stream'],
    ]);
    expect(entries[0]![1]).not.toBe('Bearer plain');
    expect(entries[1]![1]).toBe(existing);
    expect(entries[2]![1]).toBe('text/event-stream');
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(materializeHeaderLines(entries)).toEqual([
      ['Authorization', 'Bearer plain'],
      ['x-api-key', 'existing-bearer'],
      ['content-type', 'text/event-stream'],
    ]);
    expect(headersFromEntries(entries).get('authorization')).toBe('Bearer plain');
  });
});

describe('httpTerminal', () => {
  test('materializes a structured URL for dispatch while the dump encoder redacts its secret query', async () => {
    const apiKey = secret('sk-dump-query-secret');
    let encoded: ReturnType<ReturnType<typeof createDumpEncoder>['encodeBatch']> = [];
    const dumpEncoder = createDumpEncoder({ detectRawSecretLeaks: true });
    const traceSink: RunTraceSink = {
      push: event => {
        encoded = [...encoded, ...dumpEncoder.encodeBatch([event])];
      },
      registerSecretPlaintext: plaintext => dumpEncoder.registerSecretPlaintext(plaintext),
    };
    let fetchedUrl = '';
    const request: UpstreamHttpRequest = {
      method: 'GET',
      url: {
        origin: 'https://api.example.test',
        pathname: '/v1/models',
        query: [['key', apiKey], ['alt', 'sse']],
      },
      headers: [
        ['Authorization', secret('Bearer dump-token')],
        ['Accept', 'text/event-stream'],
      ],
    };

    const outcome = await runPipeline(pipelineFor('dump-http'), { 'request.http': request }, {
      services: services(async (url, init) => {
        fetchedUrl = url;
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer dump-token');
        return new Response(null, { status: 204 });
      }),
      traceSink,
    });

    expect(fetchedUrl).toBe('https://api.example.test/v1/models?key=sk-dump-query-secret&alt=sse');
    expect(outcome.body).toBeNull();
    expect(encoded.length).toBeGreaterThan(0);
    expect(JSON.stringify(encoded)).not.toContain('sk-dump-query-secret');
  });

  test('wraps sensitive response headers and preserves repeated set-cookie lines', async () => {
    const headers = new Headers();
    headers.append('authorization', 'Bearer upstream-response');
    headers.append('set-cookie', 'one=1; Path=/');
    headers.append('set-cookie', 'two=2; Path=/');
    headers.append('content-type', 'application/json');

    const result = await executeHttp({
      method: 'POST',
      url: 'https://example.test/v1/responses',
      headers: [['x-api-key', secret('request-key')]],
      body: { kind: 'json', value: { input: 'hello' } },
    }, async () => new Response('{}', { status: 200, headers }));

    const authorization = result.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    const cookies = result.headers.filter(([name]) => name.toLowerCase() === 'set-cookie');
    expect(isSecret(authorization)).toBe(true);
    expect(cookies).toHaveLength(2);
    expect(cookies.every(([, value]) => isSecret(value))).toBe(true);
    expect(decoder.decode(await readManagedBytes(result.body))).toBe('{}');
  });

  test('supports raw and string bodies and adds content type only when absent', async () => {
    const observed: Array<{ body: string; contentType: string | null }> = [];
    const fetcher = async (_url: string, init: FetchInit): Promise<Response> => {
      observed.push({
        body: isReplayableBody(init.body)
          ? await new Response(init.body.open()).text()
          : await new Response(init.body as BodyInit).text(),
        contentType: new Headers(init.headers).get('content-type'),
      });
      return new Response(null, { status: 204 });
    };
    await executeHttp({
      method: 'POST',
      url: 'https://example.test/raw',
      headers: [],
      body: { kind: 'raw', bytes: encoder.encode('raw-body'), contentType: 'application/octet-stream' },
    }, fetcher);
    await executeHttp({
      method: 'POST',
      url: 'https://example.test/string',
      headers: [['Content-Type', 'text/plain']],
      body: 'string-body',
    }, fetcher);
    expect(observed).toEqual([
      { body: 'raw-body', contentType: 'application/octet-stream' },
      { body: 'string-body', contentType: 'text/plain' },
    ]);
  });

  test('adds JSON content type and stamps dispatch timing', async () => {
    const dispatch: Array<{ upstreamId: string; startedAtMs: number; headersAtMs?: number }> = [];
    let observedBody = '';
    let tick = 10;
    const outcome = await runPipeline(pipelineFor('timing-up'), {
      'request.http': {
        method: 'POST',
        url: 'https://example.test/json',
        headers: [],
        body: { kind: 'json', value: { exponent: 1e21 } },
      },
    }, {
      services: services(async (_url, init) => {
        observedBody = isReplayableBody(init.body)
          ? await new Response(init.body.open()).text()
          : init.body instanceof Uint8Array
            ? decoder.decode(init.body)
            : await new Response(init.body as BodyInit).text();
        expect(new Headers(init.headers).get('content-type')).toBe('application/json');
        return new Response(null, { status: 204 });
      }, info => dispatch.push(info)),
      clock: () => ++tick,
    });

    expect(observedBody).toBe('{"exponent":1e+21}');
    expect(dispatch).toEqual([
      { upstreamId: 'timing-up', startedAtMs: 11 },
      { upstreamId: 'timing-up', startedAtMs: 11, headersAtMs: 12 },
    ]);
    expect(outcome.timing).toEqual({ startedAtMs: 11, headersAtMs: 12 });
  });

  test('projects prepared content types into wire views and curl commands', async () => {
    let encodedEvents: ReturnType<ReturnType<typeof createDumpEncoder>['encodeBatch']> = [];
    let collected = createDumpEncoder();
    const traceSink: RunTraceSink = {
      push: event => {
        encodedEvents = [...encodedEvents, ...collected.encodeBatch([event])];
      },
    };
    const jsonOutcome = await runPipeline(pipelineFor('wire-json'), {
      'request.http': {
        method: 'POST',
        url: 'https://example.test/json',
        headers: [],
        body: { kind: 'json', value: { input: 'hello' } },
      },
    }, {
      services: services(async () => new Response(null, { status: 204 })),
      traceSink,
    });
    expect(jsonOutcome.status).toBe(204);

    const jsonRequest = projectWireView(createDumpDecoder().pushEvents(encodedEvents)).upstreamAttempts[0]?.request;
    expect(jsonRequest?.headers).toContainEqual(['content-type', 'application/json']);
    expect(formatCurlCommand(jsonRequest!)).toContain("--header 'content-type: application/json'");

    encodedEvents = [];
    collected = createDumpEncoder();
    await runPipeline(pipelineFor('wire-multipart'), {
      'request.http': {
        method: 'POST',
        url: 'https://example.test/multipart',
        headers: [['content-type', 'application/octet-stream']],
        body: { kind: 'multipart', parts: [{ kind: 'text', name: 'model', value: 'm' }], boundary: 'fixed-boundary' },
      },
    }, {
      services: services(async () => new Response(null, { status: 204 })),
      traceSink,
    });
    const model = createDumpDecoder().pushEvents(encodedEvents);
    const multipartRequest = projectWireView(model).upstreamAttempts.at(-1)?.request;
    expect(multipartRequest?.headers).toContainEqual(['content-type', 'multipart/form-data; boundary=fixed-boundary']);
    expect(multipartRequest?.headers.filter(([name]) => name.toLowerCase() === 'content-type')).toHaveLength(1);
    const multipartCurl = formatCurlCommand(multipartRequest!);
    expect(multipartCurl).toContain(
      "--header 'content-type: multipart/form-data; boundary=fixed-boundary'",
    );
    expect(multipartCurl).not.toContain('"kind":"multipart"');
    expect(multipartCurl).toContain('Content-Disposition: form-data; name="model"');
  });

  test.each([204, 205, 304])('returns a null body for status %i', async status => {
    const outcome = await executeHttp(
      { method: 'GET', url: 'https://example.test/no-body', headers: [] },
      async () => new Response(null, { status }),
    );
    expect(outcome.body).toBeNull();
  });
});

describe('managed stream ownership', () => {
  const failingFetcher = async (): Promise<Response> => new Response('failure', { status: 503 });

  test('reports an unread non-2xx body as a leak when an intermediate stage drops it', async () => {
    const leaking = pipeline<{ readonly 'request.http': UpstreamHttpRequest }>('leak-http')
      .end(terminal<{ readonly 'request.http': UpstreamHttpRequest }, never, ProviderPipelineServices>({
        name: 'drop-http',
        execute: async (facts, env) => {
          const ending = httpTerminal('leak-up');
          if (ending.kind !== 'terminal') throw new Error('expected HTTP terminal');
          await ending.execute(facts, env);
          throw new Error('unreachable');
        },
      }));

    const caught = await runPipeline(leaking, {
      'request.http': { method: 'GET', url: 'https://example.test/fail', headers: [] },
    }, { services: services(failingFetcher) }).catch(error => error);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.some(error => error instanceof StreamLeakError)).toBe(true);
  });

  test('returns a managed 503 body when the caller reads it', async () => {
    const outcome = await executeHttp(
      { method: 'GET', url: 'https://example.test/fail', headers: [] },
      failingFetcher,
    );
    expect(outcome.status).toBe(503);
    expect(outcome.body).not.toBeNull();
    expect(decoder.decode(await readManagedBytes(outcome.body))).toBe('failure');
    expect(outcome.body?.state).toBe('closed');
  });
});

describe('parseUpstreamSseOutcome', () => {
  const parser = (body: ReadableStream<Uint8Array>): AsyncIterable<ProtocolFrame<{ text: string }>> => (async function* () {
    const reader = body.getReader();
    let buffer = '';
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.length > 0) yield eventFrame({ text: line });
        }
      }
      yield doneFrame();
    } finally {
      if (!body.locked) return;
      reader.releaseLock();
    }
  })();

  test('returns non-2xx outcomes with the owned body intact', async () => {
    const outcome = await executeHttp(
      { method: 'GET', url: 'https://example.test/fail', headers: [] },
      async () => new Response('downstream failure', { status: 503 }),
    );
    const parsed = await runPipeline(
      pipeline<{ readonly 'request.http': UpstreamHttpRequest }>('parse-failure').end(
        terminal<{ readonly 'request.http': UpstreamHttpRequest }, Awaited<ReturnType<typeof parseUpstreamSseOutcome<{ text: string }>>>, ProviderPipelineServices>({
          name: 'parse',
          execute: async (_facts, env) => await parseUpstreamSseOutcome(outcome, parser, env),
        }),
      ),
      { 'request.http': { method: 'GET', url: 'not-used', headers: [] } },
      { services: services(async () => new Response(null, { status: 204 })) },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected failure');
    expect(parsed.http.body).toBe(outcome.body);
    expect(decoder.decode(await readManagedBytes(parsed.http.body))).toBe('downstream failure');
  });

  test('wraps SSE frames and cancels the underlying response reader on early break', async () => {
    let cancelled = false;
    let cancelledReason: unknown;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('first\n'));
      },
      cancel(reason) {
        cancelled = true;
        cancelledReason = reason;
      },
    });
    const outcome = await executeHttp(
      { method: 'GET', url: 'https://example.test/sse', headers: [] },
      async () => new Response(responseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    let eventStream: ManagedStream<ProtocolFrame<{ text: string }>> | undefined;
    let assertionError: unknown;
    const consumer = pipeline<{ readonly 'request.http': UpstreamHttpRequest }>('consume-sse').end(
      terminal<{ readonly 'request.http': UpstreamHttpRequest }, ProtocolFrame<{ text: string }>[], ProviderPipelineServices>({
        name: 'consume',
        execute: async (_facts, env) => {
          const parsed = await parseUpstreamSseOutcome(outcome, parser, env);
          if (!parsed.ok) throw new Error('expected successful SSE parsing');
          eventStream = parsed.events;
          for await (const frame of parsed.events) {
            if (frame.type === 'event') break;
          }
          return [];
        },
      }),
    );
    await runPipeline(consumer, {
      'request.http': { method: 'GET', url: 'https://example.test/sse', headers: [] },
    }, { services: services(async () => new Response(null, { status: 204 })) }).catch(error => { assertionError = error; });
    expect(assertionError).toBeUndefined();
    expect(eventStream?.state).toBe('closed');
    expect(cancelled).toBe(true);
    expect(cancelledReason).toBeDefined();
  });

  test('drains and closes a non-SSE success body before throwing its diagnostic', async () => {
    let cancelled = false;
    const rawBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"error":"not-sse"}'));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const outcome = await executeHttp(
      { method: 'GET', url: 'https://example.test/json', headers: [] },
      async () => new Response(rawBody, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const consumer = pipeline<{ readonly 'request.http': UpstreamHttpRequest }>('non-sse').end(
      terminal<{ readonly 'request.http': UpstreamHttpRequest }, never, ProviderPipelineServices>({
        name: 'consume',
        execute: async (_facts, env) => {
          await parseUpstreamSseOutcome(outcome, parser, env);
          throw new Error('unreachable');
        },
      }),
    );

    await expect(runPipeline(consumer, {
      'request.http': { method: 'GET', url: 'https://example.test/json', headers: [] },
    }, { services: services(async () => new Response(null, { status: 204 })) })).rejects.toThrow(
      'Upstream returned 200 with content-type "application/json" but stream is required (provider must force stream=true and return text/event-stream when response.ok). Body: {"error":"not-sse"}',
    );
    expect(cancelled).toBe(false);
    expect(outcome.body?.state).toBe('closed');
  });

  test('limits a non-SSE diagnostic to the first 1024 characters and releases the rest', async () => {
    let pulledPastSnippet = false;
    const rawBody = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 8; index++) {
          controller.enqueue(encoder.encode(`${index}`.padEnd(1024, index === 7 ? 'z' : 'x')));
        }
      },
      pull: async () => {
        pulledPastSnippet = true;
        await new Promise(resolve => setTimeout(resolve, 5));
      },
    });
    const outcome = await executeHttp(
      { method: 'GET', url: 'https://example.test/large-json', headers: [] },
      async () => new Response(rawBody, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const consumer = pipeline<{ readonly 'request.http': UpstreamHttpRequest }>('bounded-non-sse').end(
      terminal<{ readonly 'request.http': UpstreamHttpRequest }, never, ProviderPipelineServices>({
        name: 'consume',
        execute: async (_facts, env) => {
          await parseUpstreamSseOutcome(outcome, parser, env);
          throw new Error('unreachable');
        },
      }),
    );
    const caught = await runPipeline(consumer, {
      'request.http': { method: 'GET', url: 'https://example.test/large-json', headers: [] },
    }, { services: services(async () => new Response(null, { status: 204 })) }).catch(error => error);
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/^Upstream returned 200 with content-type "application\/json" but stream is required \(provider must force stream=true and return text\/event-stream when response\.ok\)\. Body: 0x+/);
    expect(message).not.toContain('7zzzz');
    expect(pulledPastSnippet).toBe(false);
    expect(outcome.body?.state).toBe('closed');
  });

  test('wraps configured base and path query values as secrets while preserving explicit public queries', () => {
    const built = buildWireHttpUrl(
      'https://proxy.example.com/openai?token=my-secret-token',
      '/v1/embeddings?api_key=fixture-path-secret',
      [['alt', 'sse']],
    );
    expect(built.origin).toBe('https://proxy.example.com');
    expect(built.pathname).toBe('/openai/v1/embeddings');
    expect(built.query).toHaveLength(3);
    expect(built.query?.[0]?.[0]).toBe('token');
    expect(isSecret(built.query?.[0]?.[1])).toBe(true);
    expect(built.query?.[1]?.[0]).toBe('api_key');
    expect(isSecret(built.query?.[1]?.[1])).toBe(true);
    expect(built.query?.[2]).toEqual(['alt', 'sse']);
  });

  test('serializes pure-data multipart bodies in httpTerminal without File or Blob instances', async () => {
    const audioBody = buildAudioTranscriptionMultipartBody(
      {
        entries: [
          { kind: 'text', name: 'model', value: 'whisper-client' },
          { kind: 'file', name: 'file', bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), filename: 'clip.wav', contentType: 'audio/wav' },
        ],
      },
      { type: 'replace', value: 'whisper-upstream' },
    );
    expect(audioBody).toMatchObject({ kind: 'multipart' });

    const editBody = buildImagesEditsHttpBody(
      {
        images: [{ type: 'upload', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), filename: 'in.png', contentType: 'image/png' }],
        parameters: { prompt: 'add clouds' },
      },
      'gpt-image-1',
    );
    expect(editBody).toMatchObject({ kind: 'multipart' });

    let receivedContentType = '';
    let receivedRaw = '';
    const pipe = pipeline<{ readonly 'request.http': UpstreamHttpRequest }>('mp-test')
      .end(httpTerminal('up-mp'));
    const out = await runPipeline(
      pipe,
      {
        'request.http': {
          method: 'POST',
          url: 'https://api.example.com/v1/audio/transcriptions',
          headers: [],
          body: audioBody,
        },
      },
      {
        services: {
          fetcherFor: () => async (_url, init) => {
            const hdrs = new Headers(init.headers);
            receivedContentType = hdrs.get('content-type') ?? '';
            const req = new Request('https://api.example.com/v1/audio/transcriptions', {
              method: 'POST',
              headers: hdrs,
              body: init.body as BodyInit,
            });
            receivedRaw = await req.text();
            return new Response('{"text":"hello"}', { status: 200, headers: { 'content-type': 'application/json' } });
          },
        },
      },
    );
    const respBytes = await readManagedBytes(out.body);
    expect(new TextDecoder().decode(respBytes)).toBe('{"text":"hello"}');
    expect(receivedContentType).toMatch(/^multipart\/form-data; boundary=----FlowayFormBoundary/);
    expect(receivedRaw).toContain('whisper-upstream');
    expect(receivedRaw).not.toContain('whisper-client');
    expect(receivedRaw).toContain('filename="clip.wav"');
    expect(receivedRaw).toContain('RIFF');
  });

  test('converts ProviderModel Set flags into freezeable ProviderModelFacts and builds synthetic JSON outcomes', async () => {
    const modelFacts = toProviderModelFacts({
      id: 'gpt-test',
      upstreamModelId: 'gpt-test-raw',
      limits: {},
      kind: 'chat',
      endpoints: { openaiChatCompletions: {} },
      opaqueBlobCompatibilityScope: { bindToUpstream: true },
      enabledFlags: new Set(['vendor-deepseek']),
    });
    expect(Array.isArray(modelFacts.enabledFlags)).toBe(true);
    expect(hasEnabledFlag(modelFacts, 'vendor-deepseek')).toBe(true);
    expect(hasEnabledFlag(modelFacts, 'vendor-kimi')).toBe(false);

    const synthPipe = pipeline<{ readonly 'provider.model': typeof modelFacts }>('synth-test').end(
      terminal<{ readonly 'provider.model': typeof modelFacts }, ReturnType<typeof syntheticJsonOutcome>>({
        name: 'synth',
        execute: async (facts, env) => syntheticJsonOutcome(env, {
          status: 400,
          body: { error: { message: `bad ${facts['provider.model'].id}` } },
          modelKey: facts['provider.model'].upstreamModelId,
        }),
      }),
    );
    const out = await runPipeline(synthPipe, { 'provider.model': modelFacts });
    expect(out.status).toBe(400);
    expect(out.modelKey).toBe('gpt-test-raw');
    expect(decoder.decode(await readManagedBytes(out.body))).toBe('{"error":{"message":"bad gpt-test"}}');
    const rewrappedPipe = pipeline<Record<never, never>>('rewrap-test').end(
      terminal({
        name: 'rewrap',
        execute: async (_facts, env) => bytesToManagedStream(encoder.encode('abc'), env),
      }),
    );
    const stream = await runPipeline(rewrappedPipe, {});
    expect(decoder.decode(await readManagedBytes(stream))).toBe('abc');
  });
});
