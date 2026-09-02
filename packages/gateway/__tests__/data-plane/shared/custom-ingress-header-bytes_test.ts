import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';

import { afterEach, test } from 'vitest';

import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { initSocketDial, type DialedSocket } from '@floway-dev/platform';
import type { ProxyFallbackEntry } from '@floway-dev/provider';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

// Both Node egress paths end in a byte serializer of their own — undici for
// `direct_fetch`, our own writer in `@floway-dev/http` for `direct_connect` —
// so the field lines a repeated rule actually produces are asserted against a
// real socket rather than against a Headers object.

const INGRESS_HEADERS_RULES = [
  { key: 'x-passthrough', value: null },
  { key: 'x-route', value: null },
  { key: 'x-route', value: 'appended' },
  { key: 'x-configured', value: 'first' },
  { key: 'x-configured', value: 'second' },
];

const socketDial = {
  connect: (host: string, port: number): Promise<DialedSocket> => new Promise((resolve, reject) => {
    const socket: Socket = connect({ host, port });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve({
        readable: new ReadableStream<Uint8Array>({
          start: controller => {
            socket.on('data', chunk => controller.enqueue(new Uint8Array(chunk)));
            socket.on('end', () => controller.close());
            socket.on('error', error => controller.error(error));
          },
          cancel: () => { socket.destroy(); },
        }),
        writable: new WritableStream<Uint8Array>({
          write: chunk => new Promise((written, failed) => {
            socket.write(chunk, error => error ? failed(error) : written());
          }),
          close: () => { socket.end(); },
          abort: () => { socket.destroy(); },
        }),
        close: () => { socket.destroy(); return Promise.resolve(); },
      });
    });
  }),
};

let server: Server | undefined;

const startUpstream = async (): Promise<{ origin: string; received: () => IncomingMessage }> => {
  let request: IncomingMessage | undefined;
  server = createServer((incoming, response) => {
    request = incoming;
    incoming.resume();
    incoming.on('end', () => {
      const body = JSON.stringify({
        object: 'list',
        model: 'embedding-model',
        data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
    });
  });
  await new Promise<void>(listening => server!.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received: () => {
      assertExists(request);
      return request;
    },
  };
};

afterEach(async () => {
  if (!server) return;
  const closing = server;
  server = undefined;
  await new Promise<void>(closed => closing.close(() => closed()));
});

// `req.rawHeaders` is the flat wire order, so a name that arrived on two field
// lines shows up twice here — the property a combined Headers object cannot
// express.
const fieldLines = (request: IncomingMessage, name: string): string[] => {
  const lines: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) lines.push(request.rawHeaders[index + 1]);
  }
  return lines;
};

const embeddingsThroughUpstream = async (egress: ProxyFallbackEntry[], origin: string): Promise<Response> => {
  const { apiKey, repo } = await setupAppTest();
  initSocketDial(socketDial);
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_bytes',
    proxyFallbackList: egress,
    config: {
      baseUrl: origin,
      authStyle: 'bearer',
      apiKey: 'sk-custom',
      endpoints: {},
      ingressHeadersRules: INGRESS_HEADERS_RULES,
      modelsFetch: { enabled: false },
      models: [{ upstreamModelId: 'embedding-model', endpoints: { openaiEmbeddings: {} } }],
    },
  }));

  const headers = new Headers({ 'content-type': 'application/json', 'x-api-key': apiKey.key });
  headers.append('x-passthrough', 'kept-a');
  headers.append('x-passthrough', 'kept-b');
  headers.append('x-route', 'client-a');
  headers.append('x-route', 'client-b');
  headers.set('x-configured', 'client-copy');
  headers.set('x-dropped', 'gone');

  return await requestApp('/v1/embeddings', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'embedding-model', input: 'hi' }),
  });
};

// A rule set that sends a name several times reaches the wire as several
// field lines wherever the transport can express them: our own socket writer
// does, and so does workerd's `fetch`, which keeps a repeated name as a list
// and emits one line per value. Node's `fetch` cannot — undici concatenates
// inside `Headers.append`, before any transport sees the request — so an
// operator who selects `direct_fetch` on Node gets the combined form, which
// RFC 9110 §5.3 makes the same field value.
// https://github.com/cloudflare/workerd/blob/5165b467ef2a5df54768cb5f18f33b2916e58fa7/src/workerd/api/headers.c%2B%2B#L398-L440
// https://github.com/nodejs/undici/blob/v8.3.0/lib/web/fetch/headers.js#L236-L258
//
// The client's own repeated values arrive already combined: both runtimes
// merge a repeated name when the inbound request is turned into a `Headers`,
// so passthrough contributes one value however many lines the client sent.
const EXPECTED: Record<string, Record<string, string[]>> = {
  direct_connect: {
    'x-passthrough': ['kept-a, kept-b'],
    'x-route': ['client-a, client-b', 'appended'],
    'x-configured': ['first', 'second'],
    'x-dropped': [],
  },
  direct_fetch: {
    'x-passthrough': ['kept-a, kept-b'],
    'x-route': ['client-a, client-b, appended'],
    'x-configured': ['first, second'],
    'x-dropped': [],
  },
};

for (const egress of [[{ id: 'direct_fetch' }], [{ id: 'direct_connect' }]] satisfies ProxyFallbackEntry[][]) {
  test(`${egress[0].id} puts every configured value on the wire`, async () => {
    const upstream = await startUpstream();

    const response = await embeddingsThroughUpstream(egress, upstream.origin);

    assertEquals(response.status, 200);
    const request = upstream.received();
    const expected = EXPECTED[egress[0].id];
    for (const [name, lines] of Object.entries(expected)) assertEquals(fieldLines(request, name), lines);
  });
}
