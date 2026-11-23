import { expect, it } from 'vitest';

import { closed, done, enter, leave, runEvent } from './fixtures.ts';
import { createDumpDecoder, formatCurlCommand, formatWireUrl, projectWireExchanges } from '../src/browser.ts';
import { createDumpEncoder } from '../src/encoder.ts';
import { Bytes, secret } from '@floway-dev/pipeline';

const request = (pathname: string, body = Bytes.fromUtf8('input')) => ({
  method: 'POST',
  url: { origin: 'https://example.test', pathname },
  headers: [['content-type', 'application/json']] as const,
  body,
});
const response = (status: number, body: Bytes | null = null) => ({
  status, statusText: '', headers: [], body, timing: { startedAt: 1, headersAt: 2 },
});
const upstreamResponse = (status: number, body?: Bytes) => ({ ...response(status, body), exchange: 'upstream' as const });

it('projects root HTTP facts and leaf exchanges across failover and a translated route', () => {
  const original = request('/v1/responses');
  const downstream = response(200, Bytes.fromUtf8('translated output'));
  const failed = { upstreamId: 'native', targetApi: 'openai-responses' };
  const failure = { ...upstreamResponse(503), transportError: { name: 'Error', message: 'connection closed' } };
  const selected = { upstreamId: 'translated', targetApi: 'anthropic-messages' };
  const decoder = createDumpDecoder();
  decoder.pushEvents(createDumpEncoder().encodeBatch([
    runEvent,
    enter(2, 1, { 'request.http': original }),
    enter(3, 2, { 'route.candidate': failed, 'request.http': original }, 1, 'next'),
    enter(4, 3, { 'request.http': request('/reject') }, 2, 'into'),
    leave(5, 3, { 'response.http': failure }),
    closed(6, 3),
    leave(7, 2, { 'response.http': failure }, 3),
    closed(8, 2),
    enter(9, 4, { 'route.candidate': selected }, 1, 'next'),
    enter(10, 5, { 'request.http': request('/translated') }, 4, 'into'),
    enter(11, 6, { 'request.http': request('/v1/messages') }, 5, 'into'),
    leave(12, 6, { 'response.http': upstreamResponse(200, Bytes.fromUtf8('upstream output')) }),
    closed(13, 6),
    leave(14, 5, { 'response.http': downstream }, 6),
    closed(15, 5),
    leave(16, 4, { 'response.http': downstream }, 5),
    closed(17, 4),
    leave(18, 1, { 'response.http': downstream }, 4),
    closed(19, 1),
    done(20),
  ]));
  const wire = projectWireExchanges(decoder.finish());
  expect(wire.downstreamRequest?.url.pathname).toBe('/v1/responses');
  expect(wire.downstreamResponse?.status).toBe(200);
  expect((wire.downstreamResponse?.body as Bytes).utf8()).toBe('translated output');
  expect(wire.upstreamExchanges.map(exchange => [exchange.stageId, exchange.request.url.pathname, exchange.response.status])).toEqual([
    [3, '/reject', 503],
    [6, '/v1/messages', 200],
  ]);
  expect(wire.upstreamExchanges[0].response.transportError).toEqual(failure.transportError);
  expect(wire.upstreamGroups).toMatchObject([
    { candidateStageId: 2, candidate: failed, exchanges: [{ stageId: 3 }] },
    { candidateStageId: 4, candidate: selected, exchanges: [{ stageId: 6 }] },
  ]);
});

it('preserves downstream HTTP facts for a local answer', () => {
  const input = {
    ...request('/v1/responses'),
    body: { kind: 'upload-error', error: { name: 'Error', message: 'client upload failed' } },
  };
  const output = response(400);
  const decoder = createDumpDecoder();
  decoder.pushEvents(createDumpEncoder().encodeBatch([
    runEvent,
    enter(2, 1, { 'request.http': input }),
    enter(3, 2, { 'request.http': input }, 1, 'next'),
    leave(4, 2, { 'response.http': output }),
    closed(5, 2),
    leave(6, 1, { 'response.http': output }, 2),
    closed(7, 1),
    done(8),
  ]));

  const wire = projectWireExchanges(decoder.finish());
  expect(wire.downstreamRequest).toMatchObject({ ...input, stageId: 1 });
  expect(wire.downstreamResponse).toEqual(output);
  expect(wire.upstreamExchanges).toEqual([]);
  expect(wire.upstreamGroups).toEqual([]);
});

it('groups retries under the stage where their shared candidate entered', () => {
  const candidate = { upstreamId: 'retrying', targetApi: 'anthropic-messages' };
  const route = { 'route.candidate': candidate };
  const candidateRequest = { ...route, 'request.http': request('/v1/messages') };
  const decoder = createDumpDecoder();
  decoder.pushEvents(createDumpEncoder().encodeBatch([
    runEvent,
    enter(2, 1, {}),
    enter(3, 2, route, 1, 'next'),
    enter(4, 3, route, 2, 'into'),
    enter(5, 4, candidateRequest, 3, 'next'),
    leave(6, 4, { 'response.http': upstreamResponse(401) }),
    enter(7, 5, route, 2, 'into'),
    enter(8, 6, candidateRequest, 5, 'next'),
    leave(9, 6, { 'response.http': upstreamResponse(200) }),
  ]));
  const wire = projectWireExchanges(decoder.model);
  expect(wire.upstreamGroups).toMatchObject([
    { candidateStageId: 2, candidate, exchanges: [{ stageId: 4 }, { stageId: 6 }] },
  ]);
});

it('formats URL queries and curl with redaction, byte-accurate binary bodies, and shell quoting', () => {
  const token = secret('private credential');
  const url = {
    origin: 'https://example.test', pathname: '/v1/messages',
    query: [['x y', 'one & two'], ['x y', 'again'], ['custom', token], ['api_key', 'plaintext']] as const,
  };
  expect(formatWireUrl(url)).toBe('https://example.test/v1/messages?x%20y=one%20%26%20two&x%20y=again&custom=***REDACTED***&api_key=plaintext');
  const binary = formatCurlCommand({
    method: 'POST', url,
    headers: [['authorization', token], ['x-custom', "a'b"]],
    body: Bytes.copy(Uint8Array.of(0, 0xFE, 0xFF)),
  });
  expect(binary).toBe("printf '%s' 'AP7/' | base64 -d | curl --request 'POST' 'https://example.test/v1/messages?x%20y=one%20%26%20two&x%20y=again&custom=***REDACTED***&api_key=***REDACTED***' --header 'authorization: ***REDACTED***' --header 'x-custom: a'\\''b' --data-binary @-");
  expect(formatCurlCommand(request('/data', Bytes.fromUtf8("it's input")))).toContain("--data-raw 'it'\\''s input'");
  expect(formatCurlCommand(request('/data', Bytes.fromUtf8('a\r\nb')))).toContain("--data-binary $'a\\r\\nb'");
});
