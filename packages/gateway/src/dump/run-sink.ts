import { DumpAttribution, oneLineError, streamReadError } from './attribution.ts';
import { getDumpBroker, getDumpStore } from './registry.ts';
import { attemptTtftMs, type AttemptTiming } from '../data-plane/shared/attempt-timing.ts';
import type { RequestBody } from '../data-plane/shared/request-body.ts';
import type { ApiKey, TokenUsage } from '../repo/types.ts';
import { ulid } from '../shared/ulid.ts';
import { createRunRecorder, runStreamId, type RunRecorder, type StreamRecording } from '@floway-dev/dump';
import { getLogStreamStore, type BackgroundScheduler } from '@floway-dev/platform';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

// Only metadata is snapshotted here; request contents are facts recorded by the run.
interface RequestSnapshot {
  readonly method: string;
  readonly path: string;
  readonly bodyByteLength: number;
  readonly streamError: string | null;
}

export class RunDump {
  readonly id: string;
  private readonly attribution = new DumpAttribution();
  private readonly recorder: RunRecorder;
  readonly sink: RunRecorder['sink'];
  private runDrain: (() => Promise<void>) | null = null;
  private sentPayloadBytes = 0;

  constructor(
    private readonly apiKey: ApiKey,
    private readonly requestSnapshot: RequestSnapshot,
    private readonly startedAt: number,
    private readonly backgroundScheduler: BackgroundScheduler,
    private readonly wantsStream: boolean,
    private readonly timing: AttemptTiming,
  ) {
    this.id = ulid(startedAt);
    this.recorder = createRunRecorder({
      id: this.id, startedAt,
      write: record => getDumpStore().putRun(apiKey.id, record),
      publish: meta => getDumpBroker().publish(apiKey.id, meta),
      openLive: () => getLogStreamStore().open(runStreamId(apiKey.id, this.id)),
      background: backgroundScheduler,
    });
    this.sink = this.recorder.sink;
  }

  afterRun(drain: () => Promise<void>): void { this.runDrain = drain; }

  requestedModel(model: string): void {
    this.attribution.requestedModel(model);
  }

  error(kind: 'upstream' | 'gateway', upstream?: string): void {
    this.attribution.error(kind, upstream);
  }

  failed(reason: unknown, options?: { readonly fallback: boolean }): void {
    this.attribution.failed(reason, options);
  }

  frame(frame: ProtocolFrame<unknown>): void | Promise<void> {
    return this.recorder.frame(frame);
  }

  openStream(): StreamRecording { return this.recorder.openStream(); }

  openSubRequest(turn: { readonly method: string; readonly path: string }, wantsStream: boolean, timing: AttemptTiming): RunDump {
    return new RunDump(
      this.apiKey,
      { method: turn.method, path: turn.path, bodyByteLength: 0, streamError: null },
      Date.now(),
      this.backgroundScheduler,
      wantsStream,
      timing,
    );
  }

  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
    this.attribution.success(identity, usage);
  }

  recordSentPayloadBytes(byteLength: number): void {
    this.sentPayloadBytes += byteLength;
  }

  finalize(status: number | null, responseBytes: number): void;
  finalize(response: Response): Response;
  finalize(...args: [number | null, number] | [Response]): void | Response {
    if (args.length === 2) {
      const [status, responseBytes] = args;
      this.backgroundScheduler(this.write(status, responseBytes + this.sentPayloadBytes, null));
      return;
    }

    const [response] = args;
    if (response.body === null) {
      this.finalize(response.status, 0);
      return response;
    }

    const [forClient, forMeasure] = response.body.tee();
    this.backgroundScheduler((async () => {
      const reader = forMeasure.getReader();
      let payloadBytes = 0;
      let streamError: string | null = null;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          payloadBytes += value.byteLength;
        }
      } catch (err) {
        streamError = oneLineError(err);
      } finally {
        reader.releaseLock();
      }
      await this.write(response.status, payloadBytes, streamError);
    })());

    return new Response(forClient, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private async write(status: number | null, responseBytes: number, responseStreamError: string | null): Promise<void> {
    await this.recorder.finish(async () => {
      if (this.runDrain !== null) {
        try { await this.runDrain(); } catch (error) { this.failed(error); }
      }
      await this.recorder.flush();
      const completedAt = Date.now();
      return await this.attribution.metadata({
        id: this.id, startedAt: this.startedAt, completedAt,
        method: this.requestSnapshot.method, path: this.requestSnapshot.path, status,
        requestBytes: this.requestSnapshot.bodyByteLength, responseBytes,
        ttftMs: this.wantsStream ? attemptTtftMs(this.timing) : null,
        fallbackError: streamReadError(this.requestSnapshot.streamError, responseStreamError),
      });
    });
  }
}

export const openRunDump = (
  apiKey: ApiKey,
  turn: { readonly method: string; readonly path: string; readonly body: RequestBody },
  backgroundScheduler: BackgroundScheduler,
  wantsStream: boolean,
  timing: AttemptTiming,
): RunDump | null => {
  if (apiKey.dumpRetentionSeconds === null) return null;
  return new RunDump(
    apiKey,
    {
      method: turn.method,
      path: turn.path,
      bodyByteLength: turn.body.bytes.byteLength,
      streamError: turn.body.streamError,
    },
    Date.now(),
    backgroundScheduler,
    wantsStream,
    timing,
  );
};
