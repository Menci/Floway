import type { Facts } from './facts.ts';
import { snapshotError } from './snapshot-error.ts';
import type { ErrorSnapshot } from './snapshot-error.ts';
import type { LogLevel } from './stage.ts';
import type { StreamEnd } from './stream.ts';

export type StageEdge = 'root' | 'next' | 'into' | 'subrun';

type Event =
  | { readonly k: 'run'; readonly runId: string; readonly pipeline: string; readonly startedAt: number }
  | { readonly k: 'enter'; readonly stageId: number; readonly parentStageId: number | null; readonly edge: StageEdge; readonly pipeline: string; readonly name: string; readonly facts: Facts }
  | { readonly k: 'leave'; readonly stageId: number; readonly facts: Facts; readonly baseChildId?: number }
  | { readonly k: 'fail'; readonly stageId: number; readonly error: ErrorSnapshot; readonly facts: Facts }
  | { readonly k: 'closed'; readonly stageId: number; readonly ok: boolean; readonly error?: ErrorSnapshot }
  | { readonly k: 'log'; readonly stageId: number; readonly level: LogLevel; readonly message: string; readonly fields?: Facts }
  | { readonly k: 'stream'; readonly streamId: number; readonly stageId: number; readonly wraps?: number; readonly label: string }
  | { readonly k: 'frame'; readonly streamId: number; readonly value: unknown }
  | { readonly k: 'end'; readonly streamId: number; readonly how: StreamEnd['how']; readonly error?: ErrorSnapshot }
  | { readonly k: 'deferred'; readonly deferredId: number; readonly stageId: number; readonly name: string }
  | { readonly k: 'settled'; readonly deferredId: number; readonly ok: true; readonly value: unknown }
  | { readonly k: 'settled'; readonly deferredId: number; readonly ok: false; readonly error: ErrorSnapshot }
  | { readonly k: 'done'; readonly ok: boolean; readonly error?: ErrorSnapshot };

export type RunEvent = Event & { readonly seq: number; readonly tMs: number };
export type RunEventSink = (event: RunEvent) => void;

export class Trace {
  readonly diagnostics: ErrorSnapshot[] = [];
  readonly #snapshots = new WeakMap<object, ErrorSnapshot>();
  #seq = 0;
  #tMs = 0;
  #stageId = 0;
  #streamId = 0;
  #deferredId = 0;
  #finished = false;

  constructor(readonly clock: () => number, readonly sink: RunEventSink | undefined) {}

  stageId(): number { return ++this.#stageId; }
  streamId(): number { return ++this.#streamId; }
  deferredId(): number { return ++this.#deferredId; }

  snapshot(error: unknown): ErrorSnapshot {
    if (typeof error !== 'object' || error === null) return snapshotError(error);
    const earlier = this.#snapshots.get(error);
    if (earlier !== undefined) return earlier;
    const value = snapshotError(error);
    this.#snapshots.set(error, value);
    return value;
  }

  emit(event: Event): void {
    if (this.#finished || this.sink === undefined) return;
    if (event.k === 'done') this.#finished = true;
    this.#tMs = Math.max(this.#tMs, this.clock());
    try {
      this.sink(Object.freeze({ ...event, seq: ++this.#seq, tMs: this.#tMs }));
    } catch (error) {
      this.diagnostics.push(this.snapshot(error));
    }
  }
}
