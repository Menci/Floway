export const SECRET_BRAND: unique symbol = Symbol.for('floway.pipeline.secret');
export const SECRET_RENDERED: unique symbol = Symbol.for('floway.pipeline.secret.rendered');
export const STREAM_BRAND: unique symbol = Symbol.for('floway.pipeline.stream');
export const STAGE_META: unique symbol = Symbol.for('floway.pipeline.stage.meta');
export const ENDING_META: unique symbol = Symbol.for('floway.pipeline.ending.meta');
export const PIPELINE_META: unique symbol = Symbol.for('floway.pipeline.meta');
export const DISPATCH_BRAND: unique symbol = Symbol.for('floway.pipeline.dispatch');
export declare const UNBOUND_OUTCOME: unique symbol;

export interface UnboundOutcome {
  readonly [UNBOUND_OUTCOME]: never;
}

export interface Secret<out T = string> {
  readonly [SECRET_BRAND]: true;
  readonly [SECRET_RENDERED]: string;
  readonly length: number;
  readonly hash: string;
  readonly reveal: () => T;
}

export interface StoredSecret {
  readonly length: number;
  readonly hash: string;
  readonly redacted: string;
}

export type StreamResourceState = 'open' | 'iterating' | 'closing' | 'closed';

export type StreamEndHow = 'exhausted' | 'closed' | 'discarded' | 'errored' | 'leaked';

export interface ManagedStream<out T> extends AsyncIterable<T> {
  readonly [STREAM_BRAND]: true;
  readonly streamId: number;
  readonly label?: string;
  readonly owned: boolean;
  readonly state: StreamResourceState;
  readonly close: (reason?: unknown) => Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

export interface CreateStreamOptions<T, Services extends object = Record<never, never>> {
  readonly label?: string;
  readonly adopt?: readonly ManagedStream<unknown>[];
  readonly iterate: (signal: AbortSignal, env: StageEnv<Services>) => AsyncIterable<T>;
  readonly onClose?: (info: { readonly how: StreamEndHow; readonly reason?: unknown }) => void | Promise<void>;
}

export interface WrapStreamOptions<In, Out, Services extends object = Record<never, never>> {
  readonly label?: string;
  readonly adopt?: readonly ManagedStream<unknown>[];
  readonly transform: (source: AsyncIterable<In>, signal: AbortSignal, env: StageEnv<Services>) => AsyncIterable<Out>;
  readonly onClose?: (info: { readonly how: StreamEndHow; readonly reason?: unknown }) => void | Promise<void>;
}

export interface TeeStreamOptions {
  readonly labels?: readonly [string | undefined, string | undefined];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StageLogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface StageLogger {
  readonly debug: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly warn: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export type TapPoint = 'downstream' | 'upstream';

export type StageEdgeKind = 'root' | 'child' | 'dispatch' | 'subrun';

export type Facts = { readonly [key: string]: unknown };

export type DeepReadonly<T> =
  T extends Secret<unknown> | ManagedStream<unknown> | Uint8Array | Error | ((...args: never[]) => unknown) | { readonly rawJSON: string }
    ? T
    : T extends readonly (infer E)[]
      ? readonly DeepReadonly<E>[]
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

type HasRequiredKeys<T extends object> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T] extends never ? false : true;

export type NextFn<Provided extends object, InnerOut> =
  HasRequiredKeys<Provided> extends true
    ? (provided: Provided) => Promise<InnerOut>
    : (provided?: Provided) => Promise<InnerOut>;

export type NextFacts<
  State extends object,
  Consumed extends PropertyKey,
  Provided extends object,
> = Omit<State, Consumed | keyof Provided> & Provided;

export type StageEnv<Services extends object = Record<never, never>> = Readonly<Services> & {
  readonly runId: string;
  readonly stageId: number;
  readonly stageName: string;
  readonly signal: AbortSignal;
  readonly clock: () => number;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly log: StageLogger;
  readonly createStream: <T>(options: CreateStreamOptions<T, Services>) => ManagedStream<T>;
  readonly wrapStream: <In, Out>(inner: ManagedStream<In>, options: WrapStreamOptions<In, Out, Services>) => ManagedStream<Out>;
  readonly teeStream: <T>(inner: ManagedStream<T>, options?: TeeStreamOptions) => readonly [ManagedStream<T>, ManagedStream<T>];
  readonly consumeInBackground: <T>(
    stream: ManagedStream<T>,
    consumer: (source: AsyncIterable<T>, signal: AbortSignal) => Promise<void>,
  ) => void;
  readonly discard: (stream: ManagedStream<unknown>, reason?: unknown) => Promise<void>;
  readonly bind: <Args extends readonly unknown[], R>(
    fn: (...args: Args) => Promise<R>,
  ) => (...args: Args) => Promise<R>;
  readonly spawnSubRun: <SubIn extends object, SubOut>(
    subPipeline: Pipeline<SubIn, SubOut, Services>,
    input: SubIn,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<SubOut>;
};

export interface StageMeta<
  Needs extends object,
  Provided extends object,
  InnerOut,
  Out,
  Consumed extends string,
  Services extends object,
> {
  readonly needs: Needs;
  readonly provided: Provided;
  readonly innerOut: InnerOut;
  readonly out: Out;
  readonly consumed: Consumed;
  readonly services: Services;
}

export interface Stage<
  Needs extends object = Record<never, never>,
  Provided extends object = Record<never, never>,
  InnerOut = unknown,
  Out = InnerOut,
  Consumed extends keyof Needs & string = never,
  Services extends object = Record<never, never>,
> {
  readonly kind: 'stage';
  readonly name: string;
  readonly tap?: TapPoint;
  readonly consumes?: readonly Consumed[];
  readonly provides?: readonly (keyof Provided & string)[];
  readonly execute: (
    facts: Readonly<Needs>,
    next: NextFn<Provided, InnerOut>,
    env: StageEnv<Services>,
  ) => Promise<Out>;
  readonly [STAGE_META]?: StageMeta<Needs, Provided, InnerOut, Out, Consumed, Services>;
}

export interface RequestStage<
  Needs extends object = Record<never, never>,
  Provided extends object = Record<never, never>,
  Consumed extends keyof Needs & string = never,
  Services extends object = Record<never, never>,
> {
  readonly kind: 'request-stage';
  readonly name: string;
  readonly tap?: TapPoint;
  readonly consumes?: readonly Consumed[];
  readonly provides?: readonly (keyof Provided & string)[];
  readonly execute: <Out>(
    facts: Readonly<Needs>,
    next: NextFn<Provided, Out>,
    env: StageEnv<Services>,
  ) => Promise<Out>;
  readonly [STAGE_META]?: StageMeta<Needs, Provided, UnboundOutcome, UnboundOutcome, Consumed, Services>;
}

export type AnyStage = Stage<any, any, any, any, any, any> | RequestStage<any, any, any, any>;

export interface BoundDispatch<out Out, in Services extends object = Record<never, never>> {
  readonly [DISPATCH_BRAND]: true;
  readonly target: Pipeline<any, Out, Services>;
  readonly input: Facts;
}

export type Ending<
  Needs extends object = Record<never, never>,
  Out = unknown,
  Services extends object = Record<never, never>,
> =
  | {
    readonly kind: 'terminal';
    readonly name: string;
    readonly tap?: TapPoint;
    readonly prepare?: (facts: Readonly<Needs>) => Needs;
    readonly execute: (facts: Readonly<Needs>, env: StageEnv<Services>) => Promise<Out>;
    readonly [ENDING_META]?: { readonly needs: Needs; readonly out: Out; readonly services: Services };
  }
  | {
    readonly kind: 'dispatch';
    readonly name: string;
    readonly tap?: TapPoint;
    readonly select: (
      facts: Readonly<Needs>,
      env: StageEnv<Services>,
    ) => BoundDispatch<Out, Services> | Promise<BoundDispatch<Out, Services>>;
    readonly [ENDING_META]?: { readonly needs: Needs; readonly out: Out; readonly services: Services };
  };

export interface Pipeline<
  in In extends object = Record<never, never>,
  out Out = unknown,
  in Services extends object = Record<never, never>,
> {
  readonly name: string;
  readonly stages: readonly AnyStage[];
  readonly ending: Ending<any, Out, any>;
  readonly [PIPELINE_META]?: (input: In, services: Services) => Out;
}

// --- Live Recording & Dump V2 Contracts ---

export type RawRunEvent =
  | {
    readonly k: 'run';
    readonly seq: number;
    readonly tMs: number;
    readonly runId: string;
    readonly pipelineName: string;
    readonly startedAt: number;
    readonly meta?: Readonly<Record<string, unknown>>;
  }
  | {
    readonly k: 'enter';
    readonly seq: number;
    readonly tMs: number;
    readonly stageId: number;
    readonly parentStageId: number | null;
    readonly edgeKind: StageEdgeKind;
    readonly name: string;
    readonly tap?: TapPoint;
    readonly facts: Facts;
  }
  | {
    readonly k: 'leave';
    readonly seq: number;
    readonly tMs: number;
    readonly stageId: number;
    readonly outcome: unknown;
  }
  | {
    readonly k: 'fail';
    readonly seq: number;
    readonly tMs: number;
    readonly stageId: number;
    readonly error: unknown;
  }
  | {
    readonly k: 'log';
    readonly seq: number;
    readonly tMs: number;
    readonly stageId: number;
    readonly level: LogLevel;
    readonly message: string;
    readonly fields?: Readonly<Record<string, unknown>>;
  }
  | {
    readonly k: 'stream';
    readonly seq: number;
    readonly tMs: number;
    readonly streamId: number;
    readonly createdByStageId: number;
    readonly wraps?: number;
    readonly label?: string;
  }
  | {
    readonly k: 'frame';
    readonly seq: number;
    readonly tMs: number;
    readonly streamId: number;
    readonly value: unknown;
  }
  | {
    readonly k: 'end';
    readonly seq: number;
    readonly tMs: number;
    readonly streamId: number;
    readonly how: StreamEndHow;
    readonly error?: unknown;
  }
  | {
    readonly k: 'done';
    readonly seq: number;
    readonly tMs: number;
    readonly ok: boolean;
    readonly summary?: Readonly<Record<string, unknown>>;
    readonly error?: unknown;
  };

export interface RunTraceSink {
  readonly push: (event: RawRunEvent) => void;
  readonly registerSecretPlaintext?: (plaintext: string) => void;
  readonly acquireProducerLease?: () => () => void;
}

export type StoredRef = { readonly $: number };

export type StoredValue =
  | null
  | boolean
  | number
  | string
  | StoredRef
  | { readonly $stream: number }
  | { readonly $secret: StoredSecret }
  | { readonly $bytes: string }
  | { readonly $undefined: true }
  | { readonly $number: '-0' | 'NaN' | 'Infinity' | '-Infinity' }
  | { readonly $bigint: string }
  | { readonly $rawJson: string }
  | { readonly $error: { readonly [key: string]: StoredValue } }
  | readonly StoredValue[]
  | { readonly [key: string]: StoredValue };

export type EncodedDumpEvent =
  | {
    readonly k: 'run';
    readonly seq: number;
    readonly tMs: number;
    readonly runId: string;
    readonly pipelineName: string;
    readonly startedAt: number;
    readonly meta?: StoredValue;
  }
  | {
    readonly k: 'obj';
    readonly from: number;
    readonly nodes: readonly StoredValue[];
  }
  | {
    readonly k: 'enter';
    readonly seq: number;
    readonly tMs: number;
    readonly stageId: number;
    readonly parentStageId: number | null;
    readonly edgeKind: StageEdgeKind;
    readonly name: string;
    readonly tap?: TapPoint;
    readonly facts: StoredValue;
  }
  | {
    readonly k: 'leave';
    readonly seq: number;
    readonly tMs: number;
    readonly stageId: number;
    readonly outcome: StoredValue;
  }
  | {
    readonly k: 'fail';
    readonly seq: number;
    readonly tMs: number;
    readonly stageId: number;
    readonly error: StoredValue;
  }
  | {
    readonly k: 'log';
    readonly seq: number;
    readonly tMs: number;
    readonly stageId: number;
    readonly level: LogLevel;
    readonly message: string;
    readonly fields?: StoredValue;
  }
  | {
    readonly k: 'stream';
    readonly seq: number;
    readonly tMs: number;
    readonly streamId: number;
    readonly createdByStageId: number;
    readonly wraps?: number;
    readonly label?: string;
  }
  | {
    readonly k: 'frames';
    readonly streamId: number;
    readonly frames: ReadonlyArray<{
      readonly seq: number;
      readonly tMs: number;
      readonly v: StoredValue;
    }>;
  }
  | {
    readonly k: 'end';
    readonly seq: number;
    readonly tMs: number;
    readonly streamId: number;
    readonly how: StreamEndHow;
    readonly error?: StoredValue;
  }
  | {
    readonly k: 'truncated';
    readonly seq: number;
    readonly tMs: number;
    readonly reason: string;
    readonly droppedEvents: number;
  }
  | {
    readonly k: 'done';
    readonly seq: number;
    readonly tMs: number;
    readonly ok: boolean;
    readonly summary?: StoredValue;
    readonly error?: StoredValue;
  };

// --- Wire Tap Conventions ---

export type HeaderEntry = readonly [name: string, value: string | Secret<string>];

export interface WireHttpUrl {
  readonly origin: string;
  readonly pathname: string;
  readonly query?: ReadonlyArray<readonly [string, string | Secret<string>]>;
}

export interface WireRequestSnapshot {
  readonly method: string;
  readonly url: WireHttpUrl | string;
  readonly headers: readonly HeaderEntry[];
  readonly body?: unknown;
  readonly protocol?: string;
}

export interface WireResponseSnapshot {
  readonly status: number;
  readonly statusText?: string;
  readonly headers: readonly HeaderEntry[];
  readonly body?: unknown;
  readonly timing?: {
    readonly startedAtMs: number;
    readonly headersAtMs: number;
  };
}
