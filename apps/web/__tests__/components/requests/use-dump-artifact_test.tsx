import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { readDumpArtifact, useDumpArtifact } from '../../../src/components/requests/use-dump-artifact';
import { createDumpDecoder, projectWireExchanges } from '@floway-dev/dump/browser';
import type { EncodedDumpEvent } from '@floway-dev/dump/browser';
import type { DumpMetadata } from '@floway-dev/gateway/browser';

const meta: DumpMetadata = {
  id: 'record',
  startedAt: 0,
  completedAt: 10,
  method: 'POST',
  path: '/v1/chat/completions',
  status: 200,
  upstream: null,
  model: 'm',
  inputTokens: null,
  outputTokens: null,
  requestBytes: 1,
  responseBytes: 1,
  durationMs: 10,
  error: null,
};

const runEvent: EncodedDumpEvent = { k: 'run', seq: 1, tMs: 0, runId: 'run', pipeline: 'test', startedAt: 0 };
const doneEvent: EncodedDumpEvent = { k: 'done', seq: 2, tMs: 10, ok: true };
const events = [runEvent, doneEvent];
const ndjson = `${events.map(event => JSON.stringify(event)).join('\n')}\n`;

const framed = (text: string): Uint8Array => {
  const payload = new TextEncoder().encode(text);
  const bytes = new Uint8Array(payload.byteLength + 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, payload.byteLength, false);
  bytes.set(payload, 4);
  view.setUint32(4 + payload.byteLength, 0, false);
  return bytes;
};

const coldResponse = (): Response => new Response(ndjson, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });

interface HookProps {
  readonly isLive: boolean;
  readonly initialMeta: DumpMetadata | null;
}

const Hook = ({ isLive, initialMeta }: HookProps) =>
  useDumpArtifact({ keyId: 'key', recordId: 'record', isLive, initialMeta });

afterEach(() => {
  vi.unstubAllGlobals();
});

it('consumes a framed live stream and completes metadata from the detail endpoint', async () => {
  const fetched: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith('/live?offset=0')) {
      const body = framed(ndjson).slice().buffer as ArrayBuffer;
      return new Response(body, { status: 200 });
    }
    if (url.endsWith('/records/record')) return Response.json({ meta });
    throw new Error(`unexpected fetch ${url}`);
  }));

  const { result } = renderHook(Hook, { initialProps: { isLive: true, initialMeta: null } });

  await waitFor(() => expect(result.current.isLiveStreaming).toBe(false));
  expect(result.current.error).toBeNull();
  expect(result.current.artifact?.meta).toEqual(meta);
  expect(result.current.artifact?.events).toEqual(events);
  expect(fetched.some(url => url.endsWith('/artifact'))).toBe(false);
});

it('falls back to cold metadata and artifact when the live stream is gone', async () => {
  const fetched: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith('/live?offset=0')) return new Response('not found', { status: 404 });
    if (url.endsWith('/records/record')) return Response.json({ meta });
    if (url.endsWith('/artifact')) return coldResponse();
    throw new Error(`unexpected fetch ${url}`);
  }));

  const { result } = renderHook(Hook, { initialProps: { isLive: true, initialMeta: null } });

  await waitFor(() => expect(result.current.artifact?.events).toEqual(events));
  expect(result.current.error).toBeNull();
  expect(result.current.isLiveStreaming).toBe(false);
  expect(fetched.some(url => url.endsWith('/artifact'))).toBe(true);
});

it('resyncs a lagging live reader from the saved artifact once metadata is committed', async () => {
  const truncated = framed(`${JSON.stringify({ ...runEvent, runId: 'partial' })}\n`).slice(0, -4);
  let metadataCalls = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/live?offset=0')) return new Response(truncated.slice().buffer, { status: 200 });
    if (url.endsWith('/records/record')) return ++metadataCalls === 1 ? new Response(null, { status: 404 }) : Response.json({ meta });
    if (url.endsWith('/artifact')) return coldResponse();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(Hook, { initialProps: { isLive: true, initialMeta: null } });
  await waitFor(() => expect(result.current.resyncing).toBe(true));
  expect(result.current.artifact?.viewModel.run?.runId).toBe('partial');
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/artifact'))).toBe(false);
  await waitFor(() => expect(result.current.artifact?.events).toEqual(events), { timeout: 3000 });
  expect(metadataCalls).toBe(2);
  expect(result.current.error).toBeNull();
  expect(result.current.resyncing).toBe(false);
  expect(result.current.artifact?.viewModel.run?.runId).toBe('run');
});

it('recovers when the live reader ends cleanly before delivering a done event', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/live?offset=0')) return new Response(framed(JSON.stringify(runEvent)).buffer as ArrayBuffer);
    if (url.endsWith('/records/record')) return Response.json({ meta });
    if (url.endsWith('/artifact')) return coldResponse();
    throw new Error(`unexpected fetch ${url}`);
  }));
  const { result } = renderHook(Hook, { initialProps: { isLive: true, initialMeta: meta } satisfies HookProps });
  await waitFor(() => expect(result.current.artifact?.events).toEqual(events));
  expect(result.current.error).toBeNull();
  expect(result.current.isLiveStreaming).toBe(false);
  expect(result.current.artifact?.viewModel.run?.runId).toBe('run');
});

it('returns a preloaded artifact without starting a request', () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const decoder = createDumpDecoder();
  const viewModel = decoder.pushEvents(events);
  const preloaded = {
    meta,
    events,
    decoder,
    viewModel,
    wire: projectWireExchanges(viewModel),
  };
  const { result } = renderHook(() => useDumpArtifact({ keyId: 'key', recordId: 'record', isLive: true, initialMeta: meta, preloaded }));
  expect(result.current.artifact).toBe(preloaded);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('does not fetch before both identifiers are available', () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const { result } = renderHook(() => useDumpArtifact({ keyId: 'key', recordId: null, isLive: false, initialMeta: null }));
  expect(result.current).toMatchObject({ artifact: null, loading: false, isLiveStreaming: false, error: null });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('decodes an artifact with blank lines and a split UTF-8 character', async () => {
  const localized = { ...runEvent, pipeline: '管线' };
  const bytes = new TextEncoder().encode(`\n${JSON.stringify(localized)}\n\n${JSON.stringify(doneEvent)}`);
  const split = bytes.findIndex(byte => byte === 0xe7) + 1;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, split));
      controller.enqueue(bytes.subarray(split));
      controller.close();
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
  expect(await readDumpArtifact('/record')).toEqual([localized, doneEvent]);
});

it('reuses a cleanly completed live artifact when the row completes', async () => {
  const fetched: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith('/live?offset=0')) {
      const body = framed(ndjson).slice().buffer as ArrayBuffer;
      return new Response(body, { status: 200 });
    }
    if (url.endsWith('/records/record')) return Response.json({ meta });
    throw new Error(`unexpected fetch ${url}`);
  }));
  const initialProps: HookProps = { isLive: true, initialMeta: null };
  const { result, rerender } = renderHook(Hook, { initialProps });
  await waitFor(() => expect(result.current.isLiveStreaming).toBe(false));
  const completed = result.current.artifact;
  rerender({ isLive: false, initialMeta: meta });
  await waitFor(() => expect(result.current.artifact?.meta).toEqual(meta));
  expect(result.current.artifact?.decoder).toBe(completed?.decoder);
  expect(result.current.artifact?.viewModel).toBe(completed?.viewModel);
  expect(fetched.some(url => url.endsWith('/artifact'))).toBe(false);
});
