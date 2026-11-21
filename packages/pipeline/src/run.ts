import { StageScopeClosedError } from './errors.ts';
import { collectManagedStreams, freezeValue, snapshotTraceValue } from './freeze.ts';
import { RunStreamCoordinator, streamFinalization } from './stream.ts';
import type { StageScope, StreamCustodyScope } from './stream.ts';
import { DISPATCH_BRAND } from './types.ts';
import type {
  AnyStage,
  Ending,
  Facts,
  ManagedStream,
  NextFn,
  Pipeline,
  RawRunEvent,
  RequestStage,
  RunTraceSink,
  Stage,
  StageEdgeKind,
  StageEnv,
  StageLogEntry,
  StageLogger,
} from './types.ts';

type EmptyServices = Record<never, never>;
type OptionalServices<Services extends object> = Record<never, never> extends Services ? true : false;

export interface RunPipelineOptions<Services extends object = EmptyServices> {
  readonly services?: Services;
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly traceSink?: RunTraceSink;
  readonly logger?: (stageId: number, stageName: string, entry: StageLogEntry) => void;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly clock?: () => number;
}

type ServicesRequiredOptions<Services extends object> = RunPipelineOptions<Services> & {
  readonly services: Services;
};

interface RunState {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly clock: () => number;
  readonly traceSink?: RunTraceSink;
  readonly logger?: (stageId: number, stageName: string, entry: StageLogEntry) => void;
  readonly services: object;
  streams: RunStreamCoordinator;
  sequence: number;
  stageSequence: number;
  timestamp: number;
  readonly traceSnapshotCache: WeakMap<object, object>;
}

type StageContinuation<Out = unknown> = (
  facts: Facts,
  callerStageId: number,
  callerScope: StreamCustodyScope,
) => Promise<Out>;

const traceEvent = (state: RunState, make: (seq: number, tMs: number) => RawRunEvent): void => {
  if (!state.traceSink) return;
  state.timestamp = Math.max(state.timestamp, Math.max(0, state.clock()));
  state.traceSink.push(make(++state.sequence, state.timestamp));
};

const streamTraceRecorder = (state: RunState) => ({
  push: (event: RawRunEvent) => state.traceSink?.push(event),
  nextSeq: () => ++state.sequence,
  clock: () => {
    state.timestamp = Math.max(state.timestamp, Math.max(0, state.clock()));
    return state.timestamp;
  },
  snapshot: (value: unknown) => state.traceSink === undefined
    ? value
    : snapshotTraceValue(value, state.traceSnapshotCache),
});

const createRunState = <Services extends object>(
  options: RunPipelineOptions<Services> | undefined,
): RunState => {
  const abort = new AbortController();
  const parentSignal = options?.signal;
  const startedPerf = performance.now();
  const defaultClock = (): number => Math.max(0, performance.now() - startedPerf);
  if (parentSignal?.aborted) abort.abort(parentSignal.reason);
  else parentSignal?.addEventListener('abort', () => abort.abort(parentSignal.reason), { once: true });
  const state: RunState = {
    runId: options?.runId ?? crypto.randomUUID(),
    signal: abort.signal,
    clock: options?.clock ?? defaultClock,
    ...(options?.traceSink === undefined ? {} : { traceSink: options.traceSink }),
    ...(options?.logger === undefined ? {} : { logger: options.logger }),
    services: (options?.services ?? Object.freeze({})) as object,
    streams: undefined as unknown as RunStreamCoordinator,
    sequence: 0,
    stageSequence: 0,
    timestamp: 0,
    traceSnapshotCache: new WeakMap(),
  };
  state.streams = new RunStreamCoordinator({
    trace: streamTraceRecorder(state),
    waitUntil: promise => {
      (options?.waitUntil ?? (() => undefined))(promise);
      void promise.catch(() => undefined);
    },
  });
  return state;
};

const mergeSignals = (parent: AbortSignal, child?: AbortSignal): { signal: AbortSignal; dispose: () => void } => {
  if (!child) return { signal: parent, dispose: () => undefined };
  const combined = new AbortController();
  const propagate = (): void => combined.abort(parent.aborted ? parent.reason : child.reason);
  if (parent.aborted || child.aborted) propagate();
  else {
    parent.addEventListener('abort', propagate, { once: true });
    child.addEventListener('abort', propagate, { once: true });
  }
  return {
    signal: combined.signal,
    dispose: () => {
      parent.removeEventListener('abort', propagate);
      child.removeEventListener('abort', propagate);
    },
  };
};

type StageLike = Pick<AnyStage, 'name' | 'consumes' | 'provides'>;

const providedEntries = (stage: StageLike, provided: object): [string, unknown][] => {
  const entries = Object.entries(provided);
  if (!stage.provides) return entries;
  const allowed = new Set(stage.provides);
  return entries.filter(([key]) => allowed.has(key as never));
};

const nextFacts = (baseFacts: Facts, stage: StageLike, provided?: object): Facts => {
  if (
    provided === undefined
    && (!stage.consumes || stage.consumes.length === 0)
    && (!stage.provides || stage.provides.length === 0)
  ) return baseFacts;
  const copied = { ...baseFacts } as Record<string, unknown>;
  for (const key of stage.consumes ?? []) delete copied[key];
  for (const key of stage.provides ?? []) delete copied[key];
  if (provided) {
    for (const [key, value] of providedEntries(stage, provided)) {
      if (value === undefined) delete copied[key];
      else copied[key] = freezeValue(value, key);
    }
  }
  return Object.freeze(copied);
};

const loggerFor = (
  state: RunState,
  stageId: number,
  stageName: string,
): StageLogger => {
  const emit = (level: StageLogEntry['level'], message: string, fields?: Readonly<Record<string, unknown>>): void => {
    const frozenFields = fields === undefined ? undefined : freezeValue(fields, 'log.fields');
    const entry: StageLogEntry = {
      level,
      message,
      ...(frozenFields === undefined ? {} : { fields: frozenFields }),
    };
    state.logger?.(stageId, stageName, entry);
    traceEvent(state, (seq, tMs) => ({
      k: 'log',
      seq,
      tMs,
      stageId,
      ...entry,
      ...(entry.fields === undefined || state.traceSink === undefined
        ? {}
        : { fields: snapshotTraceValue(entry.fields, state.traceSnapshotCache) }),
    }));
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
};

type StageNextImplementation = (
  custody: StreamCustodyScope,
  provided?: object,
) => Promise<unknown>;

const stageNextImplementations = new WeakMap<Function, StageNextImplementation>();

const custodyFor = (scope: StreamCustodyScope, operation: string): StreamCustodyScope => {
  scope.assertOpen(operation);
  return scope;
};

const createEnvironment = (
  state: RunState,
  scope: StreamCustodyScope,
  stageId: number,
  stageName: string,
  signal: AbortSignal,
  spawnSubRun: (
    subPipeline: Pipeline<any, any, any>,
    input: Facts,
    subSignal: AbortSignal,
    callerScope: StreamCustodyScope,
  ) => Promise<unknown>,
): StageEnv<any> => {
  const spawn = async (
    subPipeline: Pipeline<any, any, any>,
    input: Facts,
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown> => {
    const custody = custodyFor(scope, 'spawnSubRun()');
    const merged = mergeSignals(signal, options?.signal);
    const frozen = freezeValue(input, 'subInput') as Facts;
    try {
      const value = await custody.trackPending(spawnSubRun(subPipeline, frozen, merged.signal, custody));
      const subStreams = collectManagedStreams(value);
      const liveStreams = subStreams.filter(stream => stream.state === 'open' || stream.state === 'iterating');
      if (liveStreams.length === 0) {
        merged.dispose();
        return value;
      }
      const disposed = Promise.allSettled(liveStreams.map(streamFinalization)).finally(merged.dispose);
      void disposed;
      return value;
    } catch (error) {
      merged.dispose();
      throw error;
    }
  };

  return {
    ...(state.services as object),
    runId: state.runId,
    stageId,
    stageName,
    signal,
    clock: state.clock,
    waitUntil: state.streams.waitUntil,
    log: loggerFor(state, stageId, stageName),
    createStream: options => custodyFor(scope, 'createStream()').createStream(options),
    wrapStream: (inner, options) => custodyFor(scope, 'wrapStream()').wrapStream(inner, options),
    discard: async (stream, reason) => {
      await custodyFor(scope, 'discard()').discard(stream, reason);
    },
    bind: <Args extends readonly unknown[], R>(fn: (...args: Args) => Promise<R>) => (...args: Args): Promise<R> => {
      const implementation = stageNextImplementations.get(fn);
      if (implementation) return implementation(scope, args[0] as object | undefined) as Promise<R>;
      scope.assertOpen('bind()');
      return scope.trackPending(fn(...args));
    },
    spawnSubRun: spawn,
  } as StageEnv<any>;
};

const createScope = (
  state: RunState,
  stageId: number,
  stageName: string,
  signal: AbortSignal,
  parent?: StreamCustodyScope,
): StageScope => state.streams.createScope({
  stageId,
  stageName,
  signal,
  ...(parent === undefined ? {} : { parent }),
});

interface CallStageOptions<Out> {
  readonly state: RunState;
  readonly stage: AnyStage | Ending<any, any, any>;
  readonly facts: Facts;
  readonly parentStageId: number | null;
  readonly edgeKind: StageEdgeKind;
  readonly signal: AbortSignal;
  readonly continuation: StageContinuation<Out>;
  readonly callerScope?: StreamCustodyScope;
  readonly registerRoot?: (stream: ManagedStream<unknown>) => void;
}

const callStage = async <Out>(options: CallStageOptions<Out>): Promise<Out> => {
  const { state, stage, facts, parentStageId, edgeKind, signal, continuation, callerScope, registerRoot } = options;
  const stageId = ++state.stageSequence;
  const stageName = stage.name;
  const scope = createScope(state, stageId, stageName, signal, callerScope);

  const nextImplementation = async (custody: StreamCustodyScope, provided?: object): Promise<Out> => {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const nextInput = nextFacts(facts, stage as StageLike, provided);
    const tracked = custody.trackPending(continuation(nextInput, stageId, custody));
    return freezeValue(await tracked, 'outcome');
  };

  const next = async (provided?: object): Promise<Out> => {
    if (scope.isExecuteFinished()) throw new StageScopeClosedError(stageName, 'next()');
    return await nextImplementation(custodyFor(scope, 'next()'), provided);
  };
  stageNextImplementations.set(next, nextImplementation as StageNextImplementation);

  const spawnSubRun = async (
    subPipeline: Pipeline<any, any, any>,
    input: Facts,
    subSignal: AbortSignal,
    subCallerScope: StreamCustodyScope,
  ): Promise<unknown> => await executePipeline(state, subPipeline, input, stageId, 'subrun', subSignal, subCallerScope);

  const environment = createEnvironment(state, scope, stageId, stageName, signal, spawnSubRun);
  scope.setEnvironment(environment);
  scope.setLazyEnvironmentFactory(lazy => createEnvironment(state, lazy, stageId, stageName, signal, spawnSubRun));

  traceEvent(state, (seq, tMs) => ({
    k: 'enter',
    seq,
    tMs,
    stageId,
    parentStageId,
    edgeKind,
    name: stageName,
    ...(stage.tap === undefined ? {} : { tap: stage.tap }),
    facts: state.traceSink ? snapshotTraceValue(facts, state.traceSnapshotCache) : facts,
  }));

  let outcome: Out | undefined;
  let executionError: unknown;
  try {
    if (stage.kind === 'stage') {
      const typed = stage as Stage<any, any, any, any, any, any>;
      outcome = await typed.execute(facts, next as NextFn<any, any>, environment) as Out;
    } else if (stage.kind === 'request-stage') {
      const typed = stage as RequestStage<any, any, any, any>;
      outcome = await typed.execute<Out>(facts, next as NextFn<any, Out>, environment);
    } else if (stage.kind === 'terminal') {
      outcome = await stage.execute(facts, environment) as Out;
    } else {
      const ending = stage as Extract<Ending<any, any, any>, { kind: 'dispatch' }>;
      const selected = await ending.select(facts, environment);
      if (!selected?.[DISPATCH_BRAND]) {
        throw new TypeError(`Dispatch "${stageName}" returned an invalid handoff`);
      }
      const dispatchInput = freezeValue(selected.input, 'dispatch.input') as Facts;
      outcome = await executePipeline(state, selected.target, dispatchInput, stageId, 'dispatch', signal, scope) as Out;
    }
    outcome = freezeValue(outcome, 'outcome');
  } catch (error) {
    executionError = error;
  }

  let cleanupError: unknown;
  let exported: readonly ManagedStream<unknown>[] = [];
  try {
    exported = executionError === undefined ? collectManagedStreams(outcome) : [];
    await scope.finish(exported, executionError === undefined ? [] : [executionError]);
    for (const stream of exported) {
      if (callerScope) {
        callerScope.receiveExport(stream);
      }
      registerRoot?.(stream);
    }
  } catch (error) {
    cleanupError = error;
  }

  if (cleanupError !== undefined) {
    traceEvent(state, (seq, tMs) => ({ k: 'fail', seq, tMs, stageId, error: cleanupError }));
    throw cleanupError;
  }
  if (executionError !== undefined) {
    traceEvent(state, (seq, tMs) => ({ k: 'fail', seq, tMs, stageId, error: executionError }));
    throw executionError;
  }
  traceEvent(state, (seq, tMs) => ({
    k: 'leave',
    seq,
    tMs,
    stageId,
    outcome: state.traceSink ? snapshotTraceValue(outcome, state.traceSnapshotCache) : outcome,
  }));
  return outcome as Out;
};

const callStageIndex = async <Out>(
  state: RunState,
  pipeline: Pipeline<any, Out, any>,
  index: number,
  facts: Facts,
  parentStageId: number | null,
  edgeKind: StageEdgeKind,
  signal: AbortSignal,
  callerScope?: StreamCustodyScope,
  registerRoot?: (stream: ManagedStream<unknown>) => void,
): Promise<Out> => {
  if (index === pipeline.stages.length) {
    return await callStage({
      state,
      stage: pipeline.ending,
      facts,
      parentStageId,
      edgeKind,
      signal,
      continuation: () => Promise.reject(new Error(`Pipeline "${pipeline.name}" has no stage after its ending`)),
      ...(callerScope === undefined ? {} : { callerScope }),
      ...(registerRoot === undefined ? {} : { registerRoot }),
    });
  }
  const stage = pipeline.stages[index]!;
  return await callStage({
    state,
    stage,
    facts,
    parentStageId,
    edgeKind,
    signal,
    ...(callerScope === undefined ? {} : { callerScope }),
    ...(registerRoot === undefined ? {} : { registerRoot }),
    continuation: (nextInput, currentStageId, currentScope) =>
      callStageIndex(state, pipeline, index + 1, nextInput, currentStageId, 'child', signal, currentScope),
  });
};

const executePipeline = async (
  state: RunState,
  pipeline: Pipeline<any, any, any>,
  input: Facts,
  parentStageId: number | null,
  edgeKind: 'root' | 'dispatch' | 'subrun',
  signal: AbortSignal,
  callerScope?: StreamCustodyScope,
  registerRoot?: (stream: ManagedStream<unknown>) => void,
): Promise<unknown> => {
  const frozen = freezeValue(input, 'input') as Facts;
  return await callStageIndex(state, pipeline, 0, frozen, parentStageId, edgeKind, signal, callerScope, registerRoot);
};

export const runPipeline = async <
  In extends object,
  Out,
  Services extends object = EmptyServices,
>(
  pipeline: Pipeline<In, Out, Services>,
  input: In,
  ...[options]: OptionalServices<Services> extends true
    ? [options?: RunPipelineOptions<Services>]
    : [options: ServicesRequiredOptions<Services>]
): Promise<Out> => {
  const normalized = options as RunPipelineOptions<Services> | undefined;
  const state = createRunState(normalized);
  const startedAt = Date.now();
  const meta = normalized?.meta === undefined ? undefined : freezeValue(normalized.meta, 'meta');
  const release = state.traceSink?.acquireProducerLease?.();
  traceEvent(state, (seq, tMs) => ({
    k: 'run',
    seq,
    tMs,
    runId: state.runId,
    pipelineName: pipeline.name,
    startedAt,
    ...(meta === undefined ? {} : { meta }),
  }));

  let result: Out | undefined;
  let error: unknown;
  try {
    const frozen = freezeValue(input, 'input') as Facts;
    result = await executePipeline(
      state,
      pipeline,
      frozen,
      null,
      'root',
      state.signal,
      undefined,
      stream => {
        void state.streams.registerRoot(stream);
      },
    ) as Out;
  } catch (failure) {
    error = failure;
  }

  const roots = state.streams.rootFinalizations();
  if (roots.length === 0) {
    traceEvent(state, (seq, tMs) => ({
      k: 'done',
      seq,
      tMs,
      ok: error === undefined,
      ...(error === undefined ? {} : { error }),
    }));
    release?.();
  } else {
    void state.streams.settleRoots().then(rootErrors => {
      const combinedErrors: unknown[] = rootErrors;
      if (error !== undefined) combinedErrors.unshift(error);
      const doneError = combinedErrors.length === 0
        ? undefined
        : combinedErrors.length === 1
          ? combinedErrors[0]
          : new AggregateError(new Set(combinedErrors), `Pipeline "${pipeline.name}" completed with errors`);
      traceEvent(state, (seq, tMs) => ({
        k: 'done',
        seq,
        tMs,
        ok: doneError === undefined,
        ...(doneError === undefined ? {} : { error: doneError }),
      }));
      release?.();
    });
  }
  if (error !== undefined) throw error;
  return result as Out;
};
