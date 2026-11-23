import { useEffect, useRef, useState } from 'react';

import { authFetch } from '../../api/client';
import { errorMessage, isAbortError } from '../../lib/error-message';
import { createDumpDecoder, projectWireExchanges } from '@floway-dev/dump/browser';
import type { DumpDecoder, DumpViewModel, EncodedDumpEvent, WireProjection } from '@floway-dev/dump/browser';
import type { DumpMetadata } from '@floway-dev/gateway/browser';
import { LogStreamTruncatedError, readLogStream } from '@floway-dev/platform/browser';

export interface LoadedDumpArtifact {
  readonly meta: DumpMetadata | null;
  readonly events: readonly EncodedDumpEvent[];
  readonly decoder: DumpDecoder;
  readonly viewModel: DumpViewModel;
  readonly wire: WireProjection;
}

interface DumpArtifactState {
  readonly artifact: LoadedDumpArtifact | null;
  readonly loading: boolean;
  readonly isLiveStreaming: boolean;
  readonly resyncing: boolean;
  readonly error: string | null;
}

interface UseDumpArtifactOptions {
  readonly keyId: string | null;
  readonly recordId: string | null;
  readonly isLive: boolean;
  readonly initialMeta: DumpMetadata | null;
  readonly initialError?: string | null;
  readonly preloaded?: LoadedDumpArtifact;
}

const IDLE: DumpArtifactState = { artifact: null, loading: false, isLiveStreaming: false, resyncing: false, error: null };

export const dumpRecordUrl = (keyId: string, recordId: string): string =>
  `/api/dump/keys/${encodeURIComponent(keyId)}/records/${encodeURIComponent(recordId)}`;

const createArtifactReader = () => {
  const decoder = createDumpDecoder();
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const events: EncodedDumpEvent[] = [];
  let pending = '';
  const parse = (text: string): void => {
    if (!text.trim()) return;
    const event = JSON.parse(text) as EncodedDumpEvent;
    decoder.pushEvents([event]);
    events.push(event);
  };
  const append = (text: string): void => {
    let start = 0;
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      parse(pending + text.slice(start, end));
      pending = '';
      start = end + 1;
    }
    pending += text.slice(start);
  };
  return {
    events,
    push: (chunk: Uint8Array) => append(utf8.decode(chunk, { stream: true })),
    finish: () => {
      append(utf8.decode());
      parse(pending);
      pending = '';
      return decoder.model.run?.done !== undefined;
    },
    artifact: (meta: DumpMetadata | null): LoadedDumpArtifact => ({
      meta, events, decoder, viewModel: decoder.model, wire: projectWireExchanges(decoder.model),
    }),
  };
};

const readArtifact = async (url: string, signal?: AbortSignal): Promise<ReturnType<typeof createArtifactReader>> => {
  const response = await authFetch(`${url}/artifact`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (response.body === null) throw new Error('Empty artifact response');
  const reader = createArtifactReader();
  const body = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await body.read();
      if (done) break;
      reader.push(value);
    }
  } catch (error) {
    await Promise.allSettled([body.cancel(error)]);
    throw error;
  } finally {
    body.releaseLock();
  }
  if (!reader.finish()) throw new Error('Incomplete dump artifact');
  return reader;
};

export const readDumpArtifact = async (url: string): Promise<readonly EncodedDumpEvent[]> =>
  (await readArtifact(url)).events;

const readMetadata = async (url: string, signal: AbortSignal): Promise<DumpMetadata | null> => {
  const response = await authFetch(url, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json() as { readonly meta: DumpMetadata }).meta;
};

const waitForMetadata = async (url: string, signal: AbortSignal): Promise<DumpMetadata> => {
  for (;;) {
    signal.throwIfAborted();
    const meta = await readMetadata(url, signal);
    if (meta !== null) return meta;
    // The live producer can end before the artifact and its index are committed.
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
  }
};

export const useDumpArtifact = ({ keyId, recordId, isLive, initialMeta, initialError, preloaded }: UseDumpArtifactOptions): DumpArtifactState => {
  const url = keyId && recordId ? dumpRecordUrl(keyId, recordId) : null;
  const [view, setView] = useState<{ url: string; state: DumpArtifactState } | null>(null);
  const completed = useRef<{ url: string; artifact: LoadedDumpArtifact } | null>(null);

  useEffect(() => {
    if (url === null || preloaded !== undefined) return;
    if (completed.current?.url === url) {
      const artifact = { ...completed.current.artifact, meta: initialMeta ?? completed.current.artifact.meta };
      setView({ url, state: { ...IDLE, artifact } });
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    const reader = createArtifactReader();
    let frame: number | null = null;
    const show = (state: DumpArtifactState): void => {
      if (!signal.aborted) setView({ url, state });
    };
    const complete = (artifact: LoadedDumpArtifact): void => {
      if (signal.aborted) return;
      completed.current = { url, artifact };
      show({ ...IDLE, artifact });
    };
    const cancelPublish = (): void => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const load = async (): Promise<void> => {
      if (!isLive) {
        show({ ...IDLE, loading: true });
        const [meta, artifact] = await Promise.all([initialMeta ?? readMetadata(url, signal), readArtifact(url, signal)]);
        if (meta === null) throw new Error('HTTP 404');
        complete(artifact.artifact(meta));
        return;
      }

      show({ ...IDLE, loading: true, isLiveStreaming: true });
      const response = await authFetch(`${url}/live?offset=0`, { signal });
      let clean = false;
      if (response.status !== 404) {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        try {
          for await (const chunk of readLogStream(response)) {
            reader.push(chunk);
            frame ??= requestAnimationFrame(() => {
              frame = null;
              show({ ...IDLE, artifact: reader.artifact(null), isLiveStreaming: true });
            });
          }
          clean = reader.finish();
        } catch (error) {
          if (!(error instanceof LogStreamTruncatedError)) throw error;
        } finally {
          cancelPublish();
        }
      }
      show({ ...IDLE, artifact: reader.artifact(null), isLiveStreaming: clean, resyncing: !clean });
      const meta = initialMeta ?? await waitForMetadata(url, signal);
      if (clean) {
        complete(reader.artifact(meta));
      } else {
        const artifact = await readArtifact(url, signal);
        complete(artifact.artifact(meta));
      }
    };
    void load().catch(error => {
      if (signal.aborted || isAbortError(error)) return;
      show({ ...IDLE, error: errorMessage(error) });
    });
    return () => {
      controller.abort();
      cancelPublish();
    };
  }, [initialMeta, isLive, preloaded, url]);

  if (preloaded !== undefined) return { ...IDLE, artifact: preloaded, error: initialError ?? null };
  if (url === null) return IDLE;
  if (initialError && !isLive) return { ...IDLE, error: initialError };
  return view?.url === url ? view.state : { ...IDLE, loading: true };
};
