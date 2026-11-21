import {
  ConcurrentStreamReadError,
  DuplicateStreamCloseError,
  StreamLeakError,
  StreamOwnershipError,
  StageScopeClosedError,
} from './errors.ts';
import { freezeValue, isManagedStream } from './freeze.ts';
import { STREAM_BRAND } from './types.ts';
import type {
  CreateStreamOptions,
  ManagedStream,
  RawRunEvent,
  StreamEndHow,
  StreamResourceState,
  StageEnv,
  WrapStreamOptions,
} from './types.ts';

export interface RunTraceRecorder {
  readonly push: (event: RawRunEvent) => void;
  readonly nextSeq: () => number;
  readonly clock: () => number;
  readonly snapshot?: (value: unknown) => unknown;
}

export interface RunStreamCoordinatorOptions {
  readonly trace?: RunTraceRecorder;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

export interface StreamScopeHost {
  readonly stageId: number;
  readonly stageName: string;
  readonly signal: AbortSignal;
  readonly parent?: StreamCustodyScope;
}

export interface StreamCustodyScope {
  readonly stageId: number;
  readonly stageName: string;
  readonly signal: AbortSignal;
  readonly environment: StageEnv<any>;
  readonly custody: Set<ManagedStream<unknown>>;
  assertOpen: (operation: string) => void;
  trackPending: <T>(promise: Promise<T>) => Promise<T>;
  createStream: <T>(options: CreateStreamOptions<T, any>) => ManagedStream<T>;
  wrapStream: <In, Out>(inner: ManagedStream<In>, options: WrapStreamOptions<In, Out>) => ManagedStream<Out>;
  discard: (stream: ManagedStream<unknown>, reason?: unknown) => Promise<void>;
  recordDiagnostic?: (error: unknown) => void;
  receiveExport: (stream: ManagedStream<unknown>) => void;
  releaseExport: (stream: ManagedStream<unknown>) => void;
}

interface Runtime {
  owned: boolean;
  state: StreamResourceState;
  readonly abort: AbortController;
  readonly finalized: Promise<void>;
  resolveFinalized: () => void;
  rejectFinalized: (error: unknown) => void;
  finalization?: Promise<void>;
  source?: AsyncIterator<unknown>;
  activeRead?: Promise<unknown>;
  sourceReturned: boolean;
  closingViaParent?: boolean;
  terminalError?: unknown;
  readonly diagnostics: unknown[];
  readonly dependencies: ManagedStream<unknown>[];
  readonly creator: StreamCustodyScope;
  holder: StreamCustodyScope;
  detachAbort: () => void;
  readonly trace?: RunTraceRecorder;
  readonly onClose?: (info: { readonly how: StreamEndHow; readonly reason?: unknown }) => void | Promise<void>;
}

interface ReadState {
  readonly stream: InternalStream<unknown>;
  readonly runtime: Runtime;
  readonly iterator: AsyncIterator<unknown>;
  readonly trace: RunTraceRecorder | undefined;
  authorized: boolean;
  reading: boolean;
  exhausted: boolean;
}

interface InternalStream<T> extends ManagedStream<T> {
  readonly [STREAM_BRAND]: true;
  readonly streamId: number;
  readonly label?: string;
  readonly owned: boolean;
  readonly state: StreamResourceState;
  readonly close: (reason?: unknown) => Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

const runtimes = new WeakMap<ManagedStream<unknown>, Runtime>();
const readStates = new WeakMap<AsyncIterator<unknown>, ReadState>();
const lazyScopes = new WeakMap<ManagedStream<unknown>, LazyStreamScope>();
const streamCreators = new WeakMap<ManagedStream<unknown>, StreamCustodyScope>();
const openIterators = new WeakMap<ManagedStream<unknown>, (authorized?: boolean) => AsyncIterator<unknown>>();
let fallbackStreamId = 0;

const runtimeFor = (stream: ManagedStream<unknown>): Runtime => {
  const runtime = runtimes.get(stream);
  if (!runtime) throw new Error(`Unknown managed stream #${stream.streamId}`);
  return runtime;
};

const ownershipError = (stream: ManagedStream<unknown>, operation: string): never => {
  throw new StreamOwnershipError(stream.streamId, operation);
};

const combine = (errors: readonly unknown[], message: string): unknown => {
  const unique = [...new Set(errors)];
  if (unique.length === 0) return undefined;
  return unique.length === 1 ? unique[0] : new AggregateError(unique, message);
};

const uniqueErrors = (errors: readonly unknown[]): unknown[] => [...new Set(errors)];

const linkAbort = (child: AbortController, parent: AbortSignal): () => void => {
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => undefined;
  }
  const abort = (): void => child.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  return () => parent.removeEventListener('abort', abort);
};

const revoke = (stream: ManagedStream<unknown>): void => {
  const runtime = runtimeFor(stream);
  if (!runtime.owned) ownershipError(stream, 'ownership transfer');
  runtime.owned = false;
};

const sameStreams = (left: readonly ManagedStream<unknown>[], right: readonly ManagedStream<unknown>[]): boolean => {
  if (left.length !== right.length) return false;
  const ids = new Set(left.map(stream => stream.streamId));
  return right.every(stream => ids.has(stream.streamId));
};

const traceStream = (
  trace: RunTraceRecorder | undefined,
  streamId: number,
  stageId: number,
  options: { readonly label?: string; readonly wraps?: number },
): void => {
  if (!trace) return;
  trace.push({
    k: 'stream',
    seq: trace.nextSeq(),
    tMs: trace.clock(),
    streamId,
    createdByStageId: stageId,
    ...(options.wraps === undefined ? {} : { wraps: options.wraps }),
    ...(options.label === undefined ? {} : { label: options.label }),
  });
};

const createStream = <T>(
  owner: StreamCustodyScope,
  coordinator: RunStreamCoordinator,
  options: CreateStreamOptions<T>,
  traceOptions: { readonly wraps?: number } = {},
): ManagedStream<T> => {
  owner.assertOpen('createStream');
  const streamId = coordinator.nextStreamId();
  const abort = new AbortController();
  const detachAbort = linkAbort(abort, owner.signal);
  let resolveFinalized = (): void => undefined;
  let rejectFinalized = (_error: unknown): void => undefined;
  const finalized = new Promise<void>((resolve, reject) => {
    resolveFinalized = resolve;
    rejectFinalized = reject;
  });
  void finalized.catch(() => undefined);
  const runtime: Runtime = {
    owned: true,
    state: 'open',
    abort,
    finalized,
    resolveFinalized,
    rejectFinalized,
    sourceReturned: false,
    diagnostics: [],
    dependencies: [],
    creator: owner,
    holder: owner,
    detachAbort,
    trace: coordinator.trace,
    ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
  };
  const stream: InternalStream<T> = {
    [STREAM_BRAND]: true,
    streamId,
    ...(options.label === undefined ? {} : { label: options.label }),
    get owned() {
      return runtime.owned;
    },
    get state() {
      return runtime.state;
    },
    [Symbol.asyncIterator]: () => openIterator(),
    close: async (reason?: unknown) => {
      if (!runtime.owned) ownershipError(stream, 'close()');
      if (runtime.state === 'closing' || runtime.state === 'closed') {
        throw new DuplicateStreamCloseError(streamId, runtime.state);
      }
      await ensureFinalization(stream, 'closed', reason).finalization;
    },
  };

  const openIterator = (authorized = false): AsyncIterator<T> => {
    if (!runtime.owned && !authorized) ownershipError(stream, '[Symbol.asyncIterator]()');
    if (runtime.state !== 'open') throw new DuplicateStreamCloseError(streamId, runtime.state);
    runtime.state = 'iterating';
    const lazy = lazyScopes.get(stream);
    try {
      const iterable = options.iterate(abort.signal, (lazy?.environment ?? owner.environment) as StageEnv<any>);
      return createIterator(stream, iterable, authorized);
    } catch (error) {
      void ensureFinalization(stream as InternalStream<unknown>, 'errored', error);
      throw error;
    }
  };
  openIterators.set(stream as ManagedStream<unknown>, openIterator as (authorized?: boolean) => AsyncIterator<unknown>);

  runtimes.set(stream as ManagedStream<unknown>, runtime);
  const parentAbort = (): void => {
    if (runtime.owned && !runtime.finalization) {
      void ensureFinalization(stream, 'closed', abort.signal.reason);
    }
  };
  owner.signal.addEventListener('abort', parentAbort, { once: true });
  const detachParentAbort = runtime.detachAbort;
  runtime.detachAbort = () => {
    owner.signal.removeEventListener('abort', parentAbort);
    detachParentAbort();
  };
  streamCreators.set(stream as ManagedStream<unknown>, owner);
  owner.custody.add(stream as ManagedStream<unknown>);
  coordinator.track(stream as ManagedStream<unknown>, runtime);
  traceStream(coordinator.trace, streamId, owner.stageId, {
    label: options.label,
    wraps: traceOptions.wraps,
  });
  return stream;
};

const promiseFor = (runtime: Runtime): Promise<void> => {
  if (runtime.finalization) return runtime.finalization;
  return runtime.finalized;
};

const abortDependencies = (runtime: Runtime, reason: unknown, seen = new Set<Runtime>()): void => {
  for (const dependency of runtime.dependencies) {
    const depRuntime = runtimeFor(dependency);
    if (seen.has(depRuntime)) continue;
    seen.add(depRuntime);
    depRuntime.closingViaParent = true;
    depRuntime.abort.abort(reason);
    abortDependencies(depRuntime, reason, seen);
  }
};

const ensureFinalization = (
  stream: InternalStream<unknown>,
  how: StreamEndHow,
  reason?: unknown,
): { created: boolean; finalization: Promise<void> } => {
  const runtime = runtimeFor(stream);
  if (runtime.finalization) return { created: false, finalization: runtime.finalization };

  runtime.state = 'closing';
  runtime.abort.abort(reason);
  abortDependencies(runtime, reason);
  runtime.finalization = finalize(stream, runtime, how, reason);
  return { created: true, finalization: runtime.finalization };
};

const finalize = async (
  stream: InternalStream<unknown>,
  runtime: Runtime,
  how: StreamEndHow,
  reason: unknown,
): Promise<void> => {
  runtime.abort.abort(reason);
  const errors: unknown[] = [];
  let terminalError: unknown;
  if (how === 'errored') terminalError = reason;
  else if (how === 'leaked') terminalError = new StreamLeakError(runtime.creator.stageName, [stream.streamId]);

  if (runtime.activeRead !== undefined) {
    await Promise.allSettled([runtime.activeRead]);
  }
  if (!runtime.sourceReturned && runtime.source !== undefined) {
    runtime.sourceReturned = true;
    try {
      await runtime.source.return?.();
    } catch (error) {
      errors.push(error);
      runtime.diagnostics.push(error);
      terminalError ??= error;
    }
  }

  try {
    await runtime.onClose?.({ how, ...(reason === undefined ? {} : { reason }) });
  } catch (error) {
    errors.push(error);
    runtime.diagnostics.push(error);
    terminalError ??= error;
  }

  for (const dependency of runtime.dependencies) {
    try {
      const dependencyRuntime = runtimeFor(dependency);
      if (dependencyRuntime.finalization) {
        await dependencyRuntime.finalization;
      } else if (dependency.state === 'open' || dependency.state === 'iterating') {
        await ensureFinalization(dependency as InternalStream<unknown>, 'closed', reason).finalization;
      }
    } catch (error) {
      errors.push(error);
      runtime.diagnostics.push(error);
    }
  }

  const lazy = lazyScopes.get(stream);
  if (lazy) {
    try {
      await lazy.finish();
    } catch (error) {
      errors.push(error);
      runtime.diagnostics.push(error);
      terminalError ??= error;
    } finally {
      lazyScopes.delete(stream);
    }
  }

  const finalizationError = combine(errors, `Stream #${stream.streamId} finalization failed`);
  if (terminalError !== undefined) runtime.terminalError = terminalError;
  else if (finalizationError !== undefined) runtime.terminalError = finalizationError;
  runtime.state = 'closed';
  runtime.detachAbort();
  if (runtime.trace) {
    runtime.trace.push({
      k: 'end',
      seq: runtime.trace.nextSeq(),
      tMs: runtime.trace.clock(),
      streamId: stream.streamId,
      how,
      ...(terminalError === undefined ? {} : { error: terminalError }),
    });
  }
  if (finalizationError !== undefined) {
    runtime.rejectFinalized(finalizationError);
    throw finalizationError;
  }
  runtime.resolveFinalized();
};

const createIterator = <T>(
  stream: InternalStream<T>,
  iterable: AsyncIterable<T>,
  authorized: boolean,
): AsyncIterator<T> => {
  const runtime = runtimeFor(stream);
  const iterator = iterable[Symbol.asyncIterator]();
  runtime.source = iterator as AsyncIterator<unknown>;
  const readState: ReadState = {
    stream: stream as InternalStream<unknown>,
    runtime,
    iterator: iterator as AsyncIterator<unknown>,
    trace: runtime.trace,
    authorized,
    reading: false,
    exhausted: false,
  };
  const iteratorObject: AsyncIterator<T> = {
    next: async (...args: [] | [unknown]) => {
      if (runtime.finalization) {
        return { value: undefined, done: true };
      }
      if (!runtime.owned && !readState.authorized) ownershipError(stream, 'iterator.next()');
      if (readState.reading) throw new ConcurrentStreamReadError(stream.streamId);
      if (readState.exhausted) return { value: undefined, done: true };

      readState.reading = true;
      try {
        let next: IteratorResult<T>;
        try {
          const activeRead = Promise.resolve(
            (iterator.next as (...nextArgs: [] | [unknown]) => Promise<IteratorResult<T>> | IteratorResult<T>)(...args),
          );
          runtime.activeRead = activeRead;
          next = await activeRead;
        } catch (sourceError) {
          readState.exhausted = true;
          if (runtime.finalization || runtime.closingViaParent) {
            return { value: undefined, done: true };
          }
          runtime.sourceReturned = true;
          runtime.terminalError ??= sourceError;
          try {
            await ensureFinalization(stream, 'errored', sourceError).finalization;
          } catch (closeError) {
            throw new AggregateError([sourceError, closeError], 'Stream iteration and cleanup both failed');
          }
          throw sourceError;
        }

        if (runtime.finalization || runtime.closingViaParent) {
          return { value: undefined, done: true };
        }
        if (next.done) {
          readState.exhausted = true;
          runtime.sourceReturned = true;
          await ensureFinalization(stream, 'exhausted').finalization;
          return { value: undefined, done: true };
        }

        let frame: T;
        try {
          frame = freezeValue(next.value, `stream#${stream.streamId}.frame`);
        } catch (validationError) {
          readState.exhausted = true;
          try {
            await ensureFinalization(stream, 'errored', validationError).finalization;
          } catch (closeError) {
            throw new AggregateError([validationError, closeError], 'Stream iteration and cleanup both failed');
          }
          throw validationError;
        }
        runtime.trace?.push({
          k: 'frame',
          seq: runtime.trace.nextSeq(),
          tMs: runtime.trace.clock(),
          streamId: stream.streamId,
          value: runtime.trace.snapshot?.(frame) ?? frame,
        });
        return { value: frame, done: false };
      } finally {
        runtime.activeRead = undefined;
        readState.reading = false;
      }
    },
    return: async () => {
      if (!runtime.owned && !readState.authorized) ownershipError(stream, 'iterator.return()');
      const finalization = runtime.finalization ?? ensureFinalization(stream, 'closed').finalization;
      try {
        await finalization;
      } catch (error) {
        runtime.holder.recordDiagnostic?.(error);
        throw error;
      }
      return { value: undefined, done: true };
    },
  };
  readStates.set(iteratorObject as AsyncIterator<unknown>, readState);
  return iteratorObject;
};

const authorizedSource = <T>(stream: ManagedStream<T>): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: () =>
    openIterators.get(stream as ManagedStream<unknown>)!(true) as AsyncIterator<T>,
});

const adopt = (
  owner: StreamCustodyScope,
  dependencies: readonly ManagedStream<unknown>[],
): void => {
  for (const dependency of dependencies) {
    revoke(dependency);
    owner.custody.delete(dependency);
  }
};

const validateDependencies = (dependencies: readonly ManagedStream<unknown>[]): void => {
  for (const dependency of dependencies) {
    if (!dependency.owned) throw new StreamOwnershipError(dependency.streamId, 'adopt');
    if (dependency.state !== 'open') throw new DuplicateStreamCloseError(dependency.streamId, dependency.state);
  }
};

const wrap = <In, Out>(
  owner: StreamCustodyScope,
  coordinator: RunStreamCoordinator,
  inner: ManagedStream<In>,
  options: WrapStreamOptions<In, Out>,
): ManagedStream<Out> => {
  owner.assertOpen('wrapStream');
  if (!inner.owned) throw new StreamOwnershipError(inner.streamId, 'wrapStream');
  if (inner.state !== 'open') throw new DuplicateStreamCloseError(inner.streamId, inner.state);

  const dependencies = [...(options.adopt ?? [])];
  validateDependencies(dependencies);
  const source = authorizedSource(inner);
  const outer = createStream(owner, coordinator, {
    ...(options.label === undefined ? {} : { label: options.label }),
    iterate: signal => options.transform(source, signal),
    ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
  }, { wraps: inner.streamId });
  const outerRuntime = runtimeFor(outer);
  outerRuntime.dependencies.push(inner, ...dependencies);
  adopt(owner, [inner, ...dependencies]);
  return outer;
};

const discard = async (
  owner: StreamCustodyScope,
  coordinator: RunStreamCoordinator,
  stream: ManagedStream<unknown>,
  reason?: unknown,
): Promise<void> => {
  owner.assertOpen('discard');
  if (!stream.owned) ownershipError(stream, 'discard()');
  const runtime = runtimeFor(stream);
  if (runtime.state === 'closing' || runtime.state === 'closed') {
    await promiseFor(runtime);
    return;
  }
  const finalization = ensureFinalization(stream as InternalStream<unknown>, 'discarded', reason).finalization;
  coordinator.waitUntil(finalization);
  await finalization;
};

const trackPending = <T>(
  pendingCalls: Set<Promise<unknown>>,
  promise: Promise<T>,
): Promise<T> => {
  pendingCalls.add(promise);
  void promise.finally(() => pendingCalls.delete(promise)).catch(() => undefined);
  return promise;
};

const settlePending = async (pendingCalls: Set<Promise<unknown>>): Promise<unknown[]> => {
  const errors: unknown[] = [];
  while (pendingCalls.size > 0) {
    const results = await Promise.allSettled([...pendingCalls]);
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason as unknown);
  }
  return errors;
};

const liveLeaks = (
  custody: Set<ManagedStream<unknown>>,
  exported: readonly ManagedStream<unknown>[],
): ManagedStream<unknown>[] => {
  const exportedIds = new Set(exported.map(stream => stream.streamId));
  return [...custody].filter(stream =>
    !exportedIds.has(stream.streamId) && (stream.state === 'open' || stream.state === 'iterating'));
};

const forceFinalizeStreams = async (
  streams: readonly ManagedStream<unknown>[],
  how: StreamEndHow,
): Promise<unknown[]> => {
  const errors: unknown[] = [];
  for (const stream of streams) {
    try {
      if (runtimeFor(stream).finalization) await runtimeFor(stream).finalization;
      else await ensureFinalization(stream as InternalStream<unknown>, how).finalization;
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
};

const forceFinalizeLeaks = async (streams: readonly ManagedStream<unknown>[]): Promise<unknown[]> =>
  await forceFinalizeStreams(streams, 'leaked');

abstract class BaseScope implements StreamCustodyScope {
  private readonly streamsStarted = new Set<ManagedStream<unknown>>();
  readonly stageId: number;
  readonly stageName: string;
  readonly signal: AbortSignal;
  readonly coordinator: RunStreamCoordinator;
  readonly custody = new Set<ManagedStream<unknown>>();
  readonly pendingCalls = new Set<Promise<unknown>>();
  readonly diagnostics: unknown[] = [];
  protected closed = false;
  protected acceptsPendingExports = false;
  private environmentValue?: StageEnv<any>;

  constructor(host: StreamScopeHost, coordinator: RunStreamCoordinator) {
    this.stageId = host.stageId;
    this.stageName = host.stageName;
    this.signal = host.signal;
    this.coordinator = coordinator;
    this.setEnvironment({
      runId: `stage-${host.stageId}`,
      stageId: host.stageId,
      stageName: host.stageName,
      signal: host.signal,
      clock: () => performance.now(),
      waitUntil: coordinator.waitUntil,
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      createStream: options => this.createStream(options),
      wrapStream: (inner, options) => this.wrapStream(inner, options),
      discard: async (stream, reason) => await this.discard(stream, reason),
      bind: <Args extends readonly unknown[], R>(fn: (...args: Args) => Promise<R>) => (...args: Args): Promise<R> => {
        this.assertOpen('bind()');
        return this.trackPending(fn(...args));
      },
      spawnSubRun: () => Promise.reject(new Error('Sub-runs require a run pipeline environment')),
    });
  }

  assertOpen(operation: string): void {
    if (this.closed) throw new StageScopeClosedError(this.stageName, operation);
  }

  get environment(): StageEnv<any> {
    if (this.environmentValue === undefined) throw new Error(`Stage "${this.stageName}" has no environment`);
    return this.environmentValue;
  }

  setEnvironment(environment: StageEnv<any>): void {
    this.environmentValue = environment;
  }

  trackPending<T>(promise: Promise<T>): Promise<T> {
    return trackPending(this.pendingCalls, promise);
  }

  createStream<T>(options: CreateStreamOptions<T>): ManagedStream<T> {
    const dependencies = [...(options.adopt ?? [])];
    validateDependencies(dependencies);
    const stream = createStream(this, this.coordinator, options);
    runtimeFor(stream).dependencies.push(...dependencies);
    this.streamsStarted.add(stream);
    adopt(this, dependencies);
    return stream;
  }

  wrapStream<In, Out>(inner: ManagedStream<In>, options: WrapStreamOptions<In, Out>): ManagedStream<Out> {
    return wrap(this, this.coordinator, inner, options);
  }

  async discard(stream: ManagedStream<unknown>, reason?: unknown): Promise<void> {
    if (!stream.owned) ownershipError(stream, 'discard()');
    await discard(this, this.coordinator, stream, reason);
  }

  recordDiagnostic(error: unknown): void {
    this.diagnostics.push(error);
  }

  isClosed(): boolean {
    return this.closed;
  }

  receiveExport(stream: ManagedStream<unknown>): void {
    if (this.closed && !this.acceptsPendingExports) this.assertOpen('receive export');
    runtimeFor(stream).holder = this;
    this.custody.add(stream);
  }

  releaseExport(stream: ManagedStream<unknown>): void {
    this.custody.delete(stream);
  }

  protected diagnosticsFor(streams: readonly ManagedStream<unknown>[]): unknown[] {
    return uniqueErrors([
      ...this.diagnostics,
      ...streams.flatMap(stream => runtimeFor(stream).diagnostics),
    ]);
  }

  protected startedInScope(): ManagedStream<unknown>[] {
    return [...this.streamsStarted];
  }

  protected finishFailure(errors: readonly unknown[], message: string): never | void {
    const error = combine(uniqueErrors(errors), message);
    if (error !== undefined) throw error;
  }
}

export class StageScope extends BaseScope {
  readonly parent?: StreamCustodyScope;
  readonly lazyScopes = new Set<LazyStreamScope>();
  private lazyEnvironmentFactory?: (scope: LazyStreamScope) => StageEnv<any>;
  private executeFinished = false;

  isExecuteFinished(): boolean {
    return this.executeFinished;
  }

  constructor(host: StreamScopeHost, coordinator: RunStreamCoordinator) {
    super(host, coordinator);
    this.parent = host.parent;
  }

  setLazyEnvironmentFactory(factory: (scope: LazyStreamScope) => StageEnv<any>): void {
    this.lazyEnvironmentFactory = factory;
  }

  attachLazyScope(stream: ManagedStream<unknown>): LazyStreamScope {
    const existing = lazyScopes.get(stream);
    if (existing) return existing;
    const lazy = new LazyStreamScope({
      stageId: this.stageId,
      stageName: this.stageName,
      signal: this.signal,
      parent: this,
    }, this.coordinator);
    if (this.lazyEnvironmentFactory) lazy.setEnvironment(this.lazyEnvironmentFactory(lazy));
    lazyScopes.set(stream, lazy);
    this.lazyScopes.add(lazy);
    return lazy;
  }

  async finish(exported: readonly ManagedStream<unknown>[], errors: readonly unknown[]): Promise<void> {
    this.executeFinished = true;
    this.closed = true;
    this.acceptsPendingExports = true;
    let pendingErrors: unknown[];
    try {
      pendingErrors = await settlePending(this.pendingCalls);
    } finally {
      this.acceptsPendingExports = false;
    }
    const combined = [...errors, ...pendingErrors];
    const transferable: ManagedStream<unknown>[] = [];
    for (const stream of exported) {
      if (!stream.owned) combined.push(new StreamOwnershipError(stream.streamId, 'export'));
      else transferable.push(stream);
    }

    const leaked = liveLeaks(this.custody, transferable);
    const leakedIds = leaked.map(stream => stream.streamId);
    combined.push(...this.diagnosticsFor([...this.custody, ...transferable]));
    combined.push(...await forceFinalizeLeaks(leaked));
    if (leakedIds.length > 0) combined.push(new StreamLeakError(this.stageName, leakedIds));

    if (combined.length > 0) {
      combined.push(...await forceFinalizeStreams(transferable, 'closed'));
      this.finishFailure(combined, `Stage "${this.stageName}" exited`);
    }

    for (const stream of transferable) {
      if (streamCreators.get(stream) === this) this.attachLazyScope(stream);
      this.custody.delete(stream);
    }
  }
}

export class LazyStreamScope extends BaseScope {
  readonly owner: StageScope;

  constructor(host: StreamScopeHost, coordinator: RunStreamCoordinator) {
    super(host, coordinator);
    this.owner = host.parent as StageScope;
  }

  async finish(errors: readonly unknown[] = []): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.acceptsPendingExports = true;
    let pendingErrors: unknown[];
    try {
      pendingErrors = await settlePending(this.pendingCalls);
    } finally {
      this.acceptsPendingExports = false;
    }
    const combined = [...errors, ...pendingErrors];
    const leaked = liveLeaks(this.custody, []);
    const leakedIds = leaked.map(stream => stream.streamId);
    combined.push(...this.diagnosticsFor([...this.custody]));
    combined.push(...await forceFinalizeLeaks(leaked));
    if (leakedIds.length > 0) combined.push(new StreamLeakError(this.stageName, leakedIds));
    this.owner.lazyScopes.delete(this);
    this.finishFailure(combined, `Lazy stage "${this.stageName}" exited`);
  }
}

export class RunStreamCoordinator {
  readonly trace?: RunTraceRecorder;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  private streamSequence = 0;
  private readonly rootStreams = new Map<ManagedStream<unknown>, Promise<void>>();

  constructor(options: RunStreamCoordinatorOptions = {}) {
    this.trace = options.trace;
    this.waitUntil = options.waitUntil ?? (() => undefined);
  }

  nextStreamId(): number {
    return ++this.streamSequence + (fallbackStreamId++ % 1);
  }

  createScope(host: StreamScopeHost): StageScope {
    return new StageScope(host, this);
  }

  track(_stream: ManagedStream<unknown>, _runtime: Runtime): void {}

  registerRoot(stream: ManagedStream<unknown>): Promise<void> {
    const existing = this.rootStreams.get(stream);
    if (existing) return existing;
    const finalization = promiseFor(runtimeFor(stream));
    this.rootStreams.set(stream, finalization);
    this.waitUntil(finalization);
    return finalization;
  }

  async settleRoots(): Promise<unknown[]> {
    let results: PromiseSettledResult<void>[];
    while (true) {
      const finalizations = this.rootFinalizations();
      results = await Promise.allSettled(finalizations);
      if (this.rootStreams.size === finalizations.length) break;
    }
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason as unknown);
    }
    for (const stream of this.rootStreams.keys()) {
      const terminalError = runtimeFor(stream).terminalError;
      if (terminalError !== undefined) errors.push(terminalError);
    }
    return uniqueErrors(errors);
  }

  rootFinalizations(): Promise<void>[] {
    return [...this.rootStreams.values()];
  }

  hasRoot(stream: ManagedStream<unknown>): boolean {
    return this.rootStreams.has(stream);
  }
}

export const createStageScope = (
  host: StreamScopeHost,
  coordinator = new RunStreamCoordinator(),
): StageScope => coordinator.createScope(host);

export const streamFinalization = (stream: ManagedStream<unknown>): Promise<void> => promiseFor(runtimeFor(stream));
export const isSameStreamSet = (left: readonly ManagedStream<unknown>[], right: readonly ManagedStream<unknown>[]): boolean =>
  sameStreams(left, right);
export { isManagedStream };
