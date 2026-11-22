import { useEffect, useRef, useState } from 'react';

import { authFetch } from '../../api/client';
import { isAbortError, errorMessage } from '../../lib/error-message';
import type { DumpMetadata } from '@floway-dev/gateway/browser';
import { createDumpDecoder, projectWireView } from '@floway-dev/pipeline/browser';
import type {
  DumpDecoder,
  DumpViewModel,
  EncodedDumpEvent,
  WireProjection,
} from '@floway-dev/pipeline/browser';
import { LogStreamTruncatedError, readLogStream } from '@floway-dev/platform/browser';

export interface LoadedDumpArtifact {
  readonly meta: DumpMetadata | null;
  readonly events: readonly EncodedDumpEvent[];
  readonly decoder: DumpDecoder;
  readonly viewModel: DumpViewModel;
  readonly wire: WireProjection;
}

export interface DumpArtifactState {
  readonly artifact: LoadedDumpArtifact | null;
  readonly loading: boolean;
  readonly isLiveStreaming: boolean;
  readonly error: string | null;
}

export interface UseDumpArtifactOptions {
  readonly keyId: string | null;
  readonly recordId: string | null;
  readonly isLive: boolean;
  readonly initialMeta: DumpMetadata | null;
  readonly initialError?: string | null;
  readonly preloaded?: LoadedDumpArtifact;
}

const IDLE: DumpArtifactState = { artifact: null, loading: false, isLiveStreaming: false, error: null };

export const parseNdjsonDumpEvents = (text: string): EncodedDumpEvent[] =>
  text.split(/\r?\n/).flatMap(line => {
    const trimmed = line.trim();
    return trimmed ? [JSON.parse(trimmed) as EncodedDumpEvent] : [];
  });

const artifactFrom = (
  decoder: DumpDecoder,
  events: readonly EncodedDumpEvent[],
  meta: DumpMetadata | null,
): LoadedDumpArtifact => {
  const view = decoder.view();
  return { meta, events, decoder, viewModel: view, wire: projectWireView(view) };
};

const readMetadata = async (keyId: string, recordId: string, signal: AbortSignal): Promise<DumpMetadata> => {
  const response = await authFetch(`/api/dump/keys/${encodeURIComponent(keyId)}/records/${encodeURIComponent(recordId)}`, { signal });
  if (!response.ok) throw new Error(`Could not load request metadata: HTTP ${response.status}`);
  return (await response.json() as { readonly meta: DumpMetadata }).meta;
};

interface NdjsonCollector {
  readonly append: (chunk: Uint8Array) => void;
  readonly finish: () => void;
}

const createNdjsonCollector = (
  events: EncodedDumpEvent[],
  onLine: (line: string) => void,
  onChunk?: (chunk: Uint8Array) => void,
): NdjsonCollector => {
  const decoder = new TextDecoder();
  let lineBuffer = '';
  const appendText = (text: string): void => {
    lineBuffer += text;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      onLine(line);
      events.push(JSON.parse(line) as EncodedDumpEvent);
    }
  };
  return {
    append: chunk => {
      onChunk?.(chunk);
      appendText(decoder.decode(chunk, { stream: true }));
    },
    finish: () => {
      appendText(decoder.decode());
      if (lineBuffer.trim()) {
        onLine(lineBuffer);
        events.push(JSON.parse(lineBuffer) as EncodedDumpEvent);
      }
      lineBuffer = '';
    },
  };
};

const readArtifact = async (
  keyId: string,
  recordId: string,
  decoder: DumpDecoder,
  events: EncodedDumpEvent[],
  signal: AbortSignal,
  onUpdate: () => void,
): Promise<void> => {
  const response = await authFetch(`/api/dump/keys/${encodeURIComponent(keyId)}/records/${encodeURIComponent(recordId)}/artifact`, { signal });
  if (!response.ok) throw new Error(`Could not load request artifact: HTTP ${response.status}`);
  if (response.body === null) throw new Error('Request artifact response carried no body');
  const reader = response.body.getReader();
  const collector = createNdjsonCollector(events, () => {}, chunk => { decoder.pushNdjsonChunk(chunk); });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      collector.append(value);
      onUpdate();
    }
    collector.finish();
    decoder.pushNdjsonChunk(new Uint8Array(), { final: true });
  } finally {
    reader.releaseLock();
  }
};

export const useDumpArtifact = (options: UseDumpArtifactOptions): DumpArtifactState => {
  const { keyId, recordId, isLive, initialMeta, initialError, preloaded } = options;
  const scope = JSON.stringify([keyId, recordId, isLive]);
  const [state, setState] = useState<DumpArtifactState>(() => preloaded !== undefined
    ? { artifact: preloaded, loading: false, isLiveStreaming: false, error: initialError ?? null }
    : IDLE);
  const [scopeState, setScopeState] = useState(scope);
  const completedLiveRef = useRef<{ key: string; artifact: LoadedDumpArtifact } | null>(null);
  if (scopeState !== scope) {
    setScopeState(scope);
    setState(preloaded !== undefined
      ? { artifact: preloaded, loading: false, isLiveStreaming: false, error: initialError ?? null }
      : IDLE);
  }

  useEffect(() => {
    if (preloaded !== undefined || !keyId || !recordId) return;
    const controller = new AbortController();
    let frame: number | null = null;
    let currentMeta = initialMeta;
    const completedKey = `${keyId}\0${recordId}`;
    const completed = completedLiveRef.current?.key === completedKey ? completedLiveRef.current.artifact : undefined;
    if (!isLive && completed !== undefined) {
      const artifact = { ...completed, meta: initialMeta ?? completed.meta };
      completedLiveRef.current = { key: completedKey, artifact };
      setState({ artifact, loading: false, isLiveStreaming: false, error: null });
      return;
    }
    let decoder = completed?.decoder ?? createDumpDecoder();
    let events = completed === undefined ? [] : [...completed.events];
    let collector = createNdjsonCollector(events, () => {}, chunk => { decoder.pushNdjsonChunk(chunk); });
    const publish = (streaming: boolean, error: string | null = null): void => {
      setState({
        artifact: artifactFrom(decoder, events, currentMeta),
        loading: false,
        isLiveStreaming: streaming,
        error,
      });
    };
    const schedulePublish = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!controller.signal.aborted) publish(true);
      });
    };
    const cancelScheduledPublish = (): void => {
      if (frame === null) return;
      cancelAnimationFrame(frame);
      frame = null;
    };

    const loadCold = async (reset: boolean): Promise<void> => {
      if (reset) {
        decoder = createDumpDecoder();
        events = [];
        collector = createNdjsonCollector(events, () => {}, chunk => { decoder.pushNdjsonChunk(chunk); });
      }
      setState(current => ({ ...current, loading: true, isLiveStreaming: false, error: null }));
      currentMeta ??= await readMetadata(keyId, recordId, controller.signal);
      await readArtifact(keyId, recordId, decoder, events, controller.signal, () => {});
      if (!controller.signal.aborted) publish(false);
    };

    const run = async (): Promise<void> => {
      if (!isLive) {
        await loadCold(false);
        return;
      }
      setState({ artifact: artifactFrom(decoder, events, currentMeta), loading: true, isLiveStreaming: true, error: null });
      try {
        const response = await authFetch(
          `/api/dump/keys/${encodeURIComponent(keyId)}/records/${encodeURIComponent(recordId)}/live?offset=0`,
          { signal: controller.signal },
        );
        if (response.status === 404) {
          await loadCold(false);
          return;
        }
        if (!response.ok) throw new Error(`Could not load live request trace: HTTP ${response.status}`);
        for await (const chunk of readLogStream(response)) {
          collector.append(chunk);
          schedulePublish();
        }
        collector.finish();
        decoder.pushNdjsonChunk(new Uint8Array(), { final: true });
        currentMeta ??= await readMetadata(keyId, recordId, controller.signal);
        cancelScheduledPublish();
        if (!controller.signal.aborted) {
          const artifact = artifactFrom(decoder, events, currentMeta);
          completedLiveRef.current = { key: completedKey, artifact };
          setState({ artifact, loading: false, isLiveStreaming: false, error: null });
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (error instanceof LogStreamTruncatedError) {
          cancelScheduledPublish();
          await loadCold(true);
          return;
        }
        cancelScheduledPublish();
        setState({ artifact: artifactFrom(decoder, events, currentMeta), loading: false, isLiveStreaming: false, error: errorMessage(error) });
      }
    };
    void run().catch(error => {
      if (controller.signal.aborted || isAbortError(error)) return;
      cancelScheduledPublish();
      setState({ artifact: artifactFrom(decoder, events, currentMeta), loading: false, isLiveStreaming: false, error: errorMessage(error) });
    });
    return () => {
      controller.abort();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [initialMeta, isLive, keyId, preloaded, recordId]);

  if (preloaded !== undefined) {
    return { artifact: preloaded, loading: false, isLiveStreaming: false, error: initialError ?? null };
  }
  return state;
};
