import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { parseNdjsonDumpEvents, useDumpArtifact } from '../../../src/components/requests/use-dump-artifact';
import type { DumpMetadata } from '@floway-dev/gateway/browser';
import { createDumpDecoder } from '@floway-dev/pipeline/browser';
import type { EncodedDumpEvent } from '@floway-dev/pipeline/browser';

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

const runEvent: EncodedDumpEvent = { k: 'run', seq: 1, tMs: 0, runId: 'run', pipelineName: 'test', startedAt: 0 };
const ndjson = `${JSON.stringify(runEvent)}\n`;

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
  expect(result.current.artifact?.events).toEqual([runEvent]);
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

  await waitFor(() => expect(result.current.artifact?.events).toEqual([runEvent]));
  expect(result.current.error).toBeNull();
  expect(result.current.isLiveStreaming).toBe(false);
  expect(fetched.some(url => url.endsWith('/artifact'))).toBe(true);
});

it('restarts cold loading from a clean decoder after live truncation', async () => {
  const partial = new TextEncoder().encode(ndjson);
  const truncated = new Uint8Array(partial.byteLength + 4);
  new DataView(truncated.buffer).setUint32(0, partial.byteLength + 10, false);
  truncated.set(partial, 4);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/live?offset=0')) return new Response(truncated.slice().buffer as ArrayBuffer, { status: 200 });
    if (url.endsWith('/records/record')) return Response.json({ meta });
    if (url.endsWith('/artifact')) return coldResponse();
    throw new Error(`unexpected fetch ${url}`);
  }));
  const { result } = renderHook(Hook, { initialProps: { isLive: true, initialMeta: meta } satisfies HookProps });
  await waitFor(() => expect(result.current.artifact?.events).toEqual([runEvent]));
  expect(result.current.error).toBeNull();
  expect(result.current.isLiveStreaming).toBe(false);
  expect(result.current.artifact?.viewModel.run?.runId).toBe('run');
});

it('returns a preloaded artifact without starting a request', () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const preloaded = {
    meta,
    events: [runEvent],
    decoder: createDumpDecoder(),
    viewModel: { run: null, stages: new Map(), rootStageIds: [], streams: new Map() },
    wire: { downstreamRequest: null, upstreamAttempts: [], downstreamResponse: null },
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

it('parses blank and multiple NDJSON lines', () => {
  expect(parseNdjsonDumpEvents(`\n${JSON.stringify(runEvent)}\n\n`)).toEqual([runEvent]);
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
