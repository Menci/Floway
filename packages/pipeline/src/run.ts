import { assemblyOf, resolveSlot } from './compose.ts';
import type { Pipeline, Slot } from './compose.ts';
import { checkDown, checkUp, findBase, requireKeys } from './declarations.ts';
import type { Answer } from './declarations.ts';
import { DeferredResource } from './deferred.ts';
import { FinalizationTimeoutError, StageScopeClosedError } from './errors.ts';
import { Trace } from './events.ts';
import type { RunEventSink, StageEdge } from './events.ts';
import { collectStreams, freezeFacts } from './facts.ts';
import type { Facts } from './facts.ts';
import type { Deferred, DeferredHandle, ManagedStream } from './handles.ts';
import type { ErrorSnapshot } from './snapshot-error.ts';
import type { LogLevel, StageEnv } from './stage.ts';
import { combineErrors, Custody, resourceOf, StreamResource, wrapOptions } from './stream.ts';
import type { CreateStreamOptions, StreamEnd, WrapStreamOptions } from './stream.ts';

export interface RunOptions<S> {
  readonly services: S;
  readonly signal?: AbortSignal;
  readonly events?: RunEventSink;
  readonly finalizationTimeoutMs: number;
  readonly runId?: string;
  readonly clock?: () => number;
}

export interface RunHandle<out O> {
  readonly result: Promise<O>;
  readonly done: Promise<RunDone>;
}

export interface RunDone {
  readonly ok: boolean;
  readonly error?: ErrorSnapshot;
}

type AnyPipeline = Pipeline<any, any, any>;
type Resource = StreamResource<unknown>;
type Failure = { readonly reason: unknown };

class RunState {
  readonly work = new Set<Promise<unknown>>();
  readonly errors: unknown[] = [];
  readonly deferred = new Set<{ abort(error: unknown): void }>();
  readonly abort = new AbortController();
  readonly signal: AbortSignal;
  readonly #finalizing = Promise.withResolvers<void>();

  constructor(readonly trace: Trace, readonly runId: string, readonly options: RunOptions<any>) {
    this.signal = options.signal ? AbortSignal.any([options.signal, this.abort.signal]) : this.abort.signal;
  }

  track<T>(work: Promise<T>, capture = true): Promise<T> {
    this.work.add(work);
    void work.then(() => {
      this.work.delete(work);
    }, error => {
      this.work.delete(work);
      if (capture) this.errors.push(error);
    });
    return work;
  }

  admitDeferred<T>(name: string, stageId: number): DeferredResource<T> {
    const resource = new DeferredResource<T>(name, this.trace, stageId);
    this.deferred.add(resource);
    const work = resource.handle.deferred.promise;
    void this.track(work);
    const remove = (): void => { this.deferred.delete(resource); };
    void work.then(remove, remove);
    return resource;
  }

  beginFinalization(): void {
    this.#finalizing.resolve();
  }

  async finish(result: Promise<unknown>): Promise<Failure | undefined> {
    await this.#finalizing.promise;
    const { finalizationTimeoutMs } = this.options;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Failure>(resolve => {
      timer = setTimeout(() => {
        const reason = new FinalizationTimeoutError(finalizationTimeoutMs);
        for (const deferred of this.deferred) deferred.abort(reason);
        this.abort.abort(reason);
        resolve({ reason });
      }, finalizationTimeoutMs);
    });
    const joined = async (): Promise<Failure | undefined> => {
      const [settled] = await Promise.allSettled([result]);
      if (settled.status === 'rejected') this.errors.unshift(settled.reason);
      while (this.work.size) await Promise.allSettled(this.work);
      return this.errors.length ? { reason: combineErrors(this.errors, 'Pipeline run failed') } : undefined;
    };
    try {
      return await Promise.race([joined(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}

class InvocationCustody extends Custody {
  readonly #pending = new Set<Promise<unknown>>();
  readonly #closed = new Set<Promise<unknown>>();

  track<T>(result: Promise<T>, closed: Promise<unknown>): Promise<T> {
    this.#pending.add(result);
    this.#closed.add(closed);
    const finished = (): void => { this.#pending.delete(result); };
    void result.then(finished, finished);
    const drained = (): void => { this.#closed.delete(closed); };
    void closed.then(drained, drained);
    return result;
  }

  async release(exclude?: ReadonlySet<Resource>): Promise<void> {
    if (this.#pending.size) await Promise.allSettled(this.#pending);
    await this.cleanup(exclude);
  }

  async join(): Promise<void> {
    try {
      await this.release();
    } finally {
      if (this.#closed.size) await Promise.allSettled(this.#closed);
    }
  }
}

class Producer extends InvocationCustody {
  readonly #abort: AbortController;
  readonly #stopReading: AbortController;
  #sealed = false;

  constructor(stageName: string, parentSignal: AbortSignal) {
    const abort = new AbortController();
    const stopReading = new AbortController();
    super(stageName, AbortSignal.any([abort.signal, parentSignal]), stopReading.signal);
    this.#abort = abort;
    this.#stopReading = stopReading;
  }

  get sealed(): boolean { return this.#sealed; }

  seal(end: StreamEnd): void {
    this.#sealed = true;
    this.#stopReading.abort();
    if (end.how === 'cancelled') this.#abort.abort(end.reason);
  }
}

class Scope {
  readonly finished: Promise<void>;
  readonly custody: InvocationCustody;
  readonly #closed = Promise.withResolvers<void>();
  readonly #ownedDeferreds = new Set<{ ownerEnded(): void }>();
  readonly #created = new Set<Resource>();
  readonly #producers = new Map<Resource, Producer>();
  readonly #pulling = new Set<Producer>();
  readonly #failures: unknown[] = [];
  #phase: 'executing' | 'draining' | 'closed' = 'executing';
  #answered = false;
  #executionJoined = false;
  #completed = false;

  constructor(
    readonly state: RunState, readonly id: number, readonly name: string, readonly signal: AbortSignal, readonly root: boolean,
  ) {
    this.custody = new InvocationCustody(name, signal);
    this.finished = state.track(this.#closed.promise, false);
  }

  admit(operation: string, executingOnly = false): InvocationCustody {
    if (!this.signal.aborted && this.#phase === 'executing') return this.custody;
    if (!executingOnly && !this.signal.aborted && this.#phase === 'draining' && this.#pulling.size === 1) {
      const [producer] = this.#pulling;
      if (!producer.sealed && !producer.signal.aborted) return producer;
    }
    throw new StageScopeClosedError(this.name, operation);
  }

  environment(): StageEnv<any> {
    const { state, id, name, signal } = this;
    const log = (level: LogLevel, message: string, fields?: Facts): void => {
      state.trace.emit({ k: 'log', stageId: id, level, message, ...(fields === undefined ? {} : { fields: freezeFacts(fields, 'log.fields') }) });
    };
    return Object.freeze({
      runId: state.runId,
      stageId: id,
      stageName: name,
      signal,
      clock: state.trace.clock,
      log: Object.freeze({
        debug: (message: string, fields?: Facts) => log('debug', message, fields),
        info: (message: string, fields?: Facts) => log('info', message, fields),
        warn: (message: string, fields?: Facts) => log('warn', message, fields),
        error: (message: string, fields?: Facts) => log('error', message, fields),
      }),
      services: state.options.services,
      createStream: <T>(options: CreateStreamOptions<T>) => this.#stream(this.admit('createStream'), options),
      wrapStream: <In, Out>(inner: ManagedStream<In>, options: WrapStreamOptions<In, Out>) => {
        const custody = this.admit('wrapStream');
        const resource = resourceOf(inner);
        resource.assertOwned(custody, 'wrapStream');
        resource.adopt();
        return this.#stream(custody, wrapOptions(resource, options), resource);
      },
      defer: <T>(name: string, work: Promise<T>): Deferred<T> => {
        this.admit('defer', true);
        const deferred = state.admitDeferred<T>(name, id);
        deferred.attach(work);
        return deferred.handle.deferred;
      },
      deferred: <T>(name: string, owner: ManagedStream<unknown> | 'scope'): DeferredHandle<T> => {
        const custody = this.admit('deferred', true);
        const stream = owner === 'scope' ? undefined : resourceOf(owner);
        stream?.assertOwned(custody, 'deferred');
        const deferred = state.admitDeferred<T>(name, id);
        if (stream) stream.bindDeferred(() => deferred.ownerEnded());
        else this.#ownedDeferreds.add(deferred);
        return deferred.handle;
      },
      run: <I, O, S>(pipeline: Pipeline<I, O, S>, facts: I): RunHandle<O> => {
        const custody = this.admit('run');
        const sub = startRun(pipeline, facts, { ...state.options, signal: custody.signal, runId: crypto.randomUUID() }, {
          trace: state.trace, caller: custody, parentStageId: id,
        });
        const joined = state.track(Promise.all([sub.done, sub.failure]).then(([, failure]) => {
          if (failure) throw failure.reason;
        }));
        return Object.freeze({ result: custody.track(sub.result, joined), done: sub.done });
      },
    });
  }

  #stream<T>(owner: InvocationCustody, options: CreateStreamOptions<T>, inner?: Resource): ManagedStream<T> {
    const { trace } = this.state;
    const streamId = trace.streamId();
    const resource = new StreamResource(owner, {
      id: streamId,
      pull: stream => {
        const producer = this.#producers.get(stream);
        if (!producer || producer.sealed) return;
        this.#pulling.add(producer);
        return () => { this.#pulling.delete(producer); };
      },
      seal: (stream, end) => {
        const producer = this.#producers.get(stream);
        if (producer) {
          this.#pulling.delete(producer);
          producer.seal(end);
        }
      },
      finish: stream => this.#producers.get(stream)?.join(),
      frame: value => trace.emit({ k: 'frame', streamId, value }),
      end: (end, error, failed) => {
        trace.emit({ k: 'end', streamId, how: end.how, ...(failed ? { error: trace.snapshot(error) } : {}) });
        if (failed) this.state.errors.push(error);
        if (this.#producers.has(resource)) {
          if (failed) this.#failures.push(error);
          this.#producers.delete(resource);
          this.#completeIfDrained();
        }
      },
    }, options, inner);
    if (owner === this.custody) this.#created.add(resource);
    void this.state.track(resource.completion, false);
    trace.emit({ k: 'stream', streamId, stageId: this.id, label: options.label, ...(inner ? { wraps: inner.id } : {}) });
    return resource.handle;
  }

  async answer(facts: Facts, recipient: Custody, baseChildId: number | undefined): Promise<void> {
    const handoff = ownedStreams(facts, this.custody, 'return');
    for (const stream of handoff) {
      if (this.#created.has(stream)) this.#producers.set(stream, new Producer(this.name, this.signal));
    }
    this.#created.clear();
    this.#phase = this.#producers.size ? 'draining' : 'closed';
    this.#answered = true;
    this.state.trace.emit({ k: 'leave', stageId: this.id, facts, ...(baseChildId === undefined ? {} : { baseChildId }) });
    if (this.root) this.state.beginFinalization();
    await this.custody.release(handoff);
    this.signal.throwIfAborted();
    for (const stream of handoff) stream.assertOwned(this.custody, 'return');
    for (const stream of handoff) stream.move(recipient);
    this.#executionJoined = true;
    this.#completeIfDrained();
  }

  fail(error: unknown, facts: Facts): void {
    this.#phase = 'closed';
    this.#created.clear();
    this.#failures.push(error);
    if (!this.#answered) this.state.trace.emit({ k: 'fail', stageId: this.id, error: this.state.trace.snapshot(error), facts });
    const cleanup = async (): Promise<void> => {
      try {
        await this.custody.release();
      } catch (error) {
        this.#failures.push(error);
        this.state.errors.push(error);
      }
      this.#executionJoined = true;
      this.#completeIfDrained();
    };
    void cleanup();
  }

  #completeIfDrained(): void {
    if (this.#completed || !this.#executionJoined || this.#producers.size) return;
    this.#completed = true;
    this.#phase = 'closed';
    for (const deferred of this.#ownedDeferreds) deferred.ownerEnded();
    this.#ownedDeferreds.clear();
    const failed = this.#failures.length > 0;
    this.state.trace.emit({
      k: 'closed', stageId: this.id, ok: !failed,
      ...(failed ? { error: this.state.trace.snapshot(combineErrors(this.#failures, 'Stage scope failed')) } : {}),
    });
    this.#closed.resolve();
  }
}

const ownedStreams = (facts: Facts, owner: Custody, operation: string): Set<Resource> => {
  const resources = new Set<Resource>();
  for (const stream of collectStreams(facts)) {
    const resource = resourceOf(stream);
    resource.assertOwned(owner, operation);
    resources.add(resource);
  }
  return resources;
};

const checkLinked = (pipeline: AnyPipeline): ReturnType<typeof assemblyOf> => {
  const assembly = assemblyOf(pipeline);
  if (!assembly.linked && Object.keys(assembly.targets).length) throw new Error(`Pipeline "${pipeline.name}" has unlinked targets`);
  return assembly;
};

interface Child {
  readonly id: number;
  readonly result: Promise<Facts>;
  readonly closed: Promise<void>;
}

interface Caller {
  readonly custody: Custody;
  readonly edge: StageEdge;
  readonly stageId: number | null;
}

const invoke = (
  state: RunState, pipeline: AnyPipeline, assembly: ReturnType<typeof assemblyOf>, index: number, facts: Facts, caller: Caller,
): Child => {
  const step = index < assembly.stages.length ? assembly.stages[index] : assembly.ending;
  const id = state.trace.stageId();
  const signal = caller.edge === 'subrun' ? state.signal : caller.custody.signal;
  const scope = new Scope(state, id, step.name, signal, caller.edge === 'root' || caller.edge === 'subrun');
  const answers: Answer[] = [];

  const runChild = (
    target: AnyPipeline, targetAssembly: ReturnType<typeof assemblyOf>, targetIndex: number, handed: Facts,
    custody: InvocationCustody, edge: 'next' | 'into', responseNeeds: readonly string[],
  ): Promise<Facts> => {
    const child = invoke(state, target, targetAssembly, targetIndex, handed, { custody, edge, stageId: id });
    const result = child.result.then(back => {
      requireKeys(step.name, 'up', back, responseNeeds);
      answers.push({ id: child.id, facts: back });
      return back;
    });
    return custody.track(result, child.closed);
  };

  const execute = async (): Promise<Facts> => {
    state.trace.emit({ k: 'enter', stageId: id, parentStageId: caller.stageId, edge: caller.edge, pipeline: pipeline.name, name: step.name, facts });
    try {
      scope.signal.throwIfAborted();
      for (const stream of ownedStreams(facts, caller.custody, 'request transfer')) stream.move(scope.custody);
      if (index === 0) requireKeys(step.name, 'entry', facts, pipeline.entry);
      const env = scope.environment();
      let output: Facts;
      let base: number | undefined;

      if (step.kind === 'stage') {
        const through = step.through;
        if (through) {
          requireKeys(step.name, 'entry', facts, through.request.needs);
          const next = (input: Facts): Promise<Facts> => {
            const custody = scope.admit('next');
            const handed = freezeFacts(input, `${step.name}.next`);
            checkDown(step.name, facts, handed, through.request);
            return runChild(pipeline, assembly, index + 1, handed, custody, 'next', through.response.needs);
          };
          output = freezeFacts(await step.execute(facts, next, env), `${step.name}.return`);
        } else {
          output = freezeFacts(await step.execute(facts, env), `${step.name}.return`);
        }
        base = checkUp(step, output, answers);
      } else {
        requireKeys(step.name, 'entry', facts, step.request.needs);
        const into: Record<string, ((...args: any[]) => Promise<Facts>)> = Object.create(null);
        const enter = (slot: Slot, key: unknown, input: unknown): Promise<Facts> => {
          const custody = scope.admit('into');
          const target = resolveSlot(slot, key, state.options.services);
          const handed = freezeFacts(input, `${step.name}.into`);
          return runChild(target, checkLinked(target), 0, handed, custody, 'into', []);
        };
        for (const [key, slot] of Object.entries(assembly.targets)) {
          into[key] = 'resolve' in slot ? (key: unknown, input: unknown) => enter(slot, key, input) : (input: unknown) => enter(slot, undefined, input);
        }
        output = freezeFacts(await step.execute(facts, Object.freeze(into), env), `${step.name}.return`);
        requireKeys(step.name, 'up', output, step.response.provides);
        base = findBase(output, answers, { provides: step.response.provides, consumes: [] });
      }

      await scope.answer(output, caller.custody, base);
      return output;
    } catch (error) {
      scope.fail(error, facts);
      throw error;
    }
  };
  return { id, result: state.track(execute(), false), closed: scope.finished };
};

interface Subrun {
  readonly trace: Trace;
  readonly caller: Custody;
  readonly parentStageId: number;
}

const startRun = <I, O, S>(pipeline: Pipeline<I, O, S>, facts: I, options: RunOptions<any>, sub?: Subrun): RunHandle<O> & {
  readonly failure: Promise<Failure | undefined>;
} => {
  if (!Number.isFinite(options.finalizationTimeoutMs) || options.finalizationTimeoutMs < 0) {
    throw new RangeError('finalizationTimeoutMs must be a nonnegative finite number');
  }
  const start = performance.now();
  const trace = sub?.trace ?? new Trace(options.clock ?? (() => performance.now() - start), options.events);
  const state = new RunState(trace, options.runId ?? crypto.randomUUID(), options);
  if (!sub) trace.emit({ k: 'run', runId: state.runId, pipeline: pipeline.name, startedAt: Date.now() });
  const execute = async (): Promise<O> => {
    const assembly = checkLinked(pipeline);
    const input = freezeFacts(facts, `${pipeline.name}.input`);
    const custody = sub?.caller ?? new Custody(pipeline.name, state.signal);
    const result = await invoke(state, pipeline, assembly, 0, input, {
      custody, edge: sub ? 'subrun' : 'root', stageId: sub?.parentStageId ?? null,
    }).result;
    return result as O;
  };
  const interrupted = Promise.withResolvers<never>();
  const wake = (): void => interrupted.reject(state.abort.signal.reason);
  state.abort.signal.addEventListener('abort', wake, { once: true });
  const result = Promise.race([execute(), interrupted.promise]);
  const settled = (): void => {
    state.abort.signal.removeEventListener('abort', wake);
    state.beginFinalization();
  };
  void result.then(settled, settled);
  const failure = state.finish(result);
  const done = failure.then(failure => {
    const completion: RunDone = failure ? { ok: false, error: trace.snapshot(failure.reason) } : { ok: true };
    if (!sub) trace.emit({ k: 'done', ...completion });
    return Object.freeze(completion);
  });
  return { result, done, failure };
};

export const run = <I, O, S>(pipeline: Pipeline<I, O, S>, facts: I, options: RunOptions<S>): RunHandle<O> => {
  const { result, done } = startRun(pipeline, facts, options);
  return Object.freeze({ result, done });
};
