import { assemblyOf, resolveSlot } from './compose.ts';
import type { Pipeline, Slot } from './compose.ts';
import { checkDown, checkUp, requireKeys } from './declarations.ts';
import type { Answer } from './declarations.ts';
import { DeferredResource } from './deferred.ts';
import type { OwnerDeferredFailure } from './deferred.ts';
import { FinalizationTimeoutError, StageScopeClosedError, StreamOwnershipError } from './errors.ts';
import { Trace } from './events.ts';
import type { RunEventSink, StageEdge } from './events.ts';
import { collectStreams, freezeFacts } from './facts.ts';
import type { Facts } from './facts.ts';
import { isManagedStream } from './handles.ts';
import type { Deferred, DeferredHandle, ManagedStream } from './handles.ts';
import type { ErrorSnapshot } from './snapshot-error.ts';
import type { ChildOptions, LogLevel, SideDecl, StageEnv, ThroughDecl } from './stage.ts';
import { combineErrors, Custody, resourceOf, StreamResource, wrapOptions, wrapStreamsOptions } from './stream.ts';
import type { CreateStreamOptions, StreamEnd, StreamFailure, StreamHooks, WrapStreamOptions, WrapStreamsOptions } from './stream.ts';

export interface RootEnv {
  readonly createStream: <T>(options: CreateStreamOptions<T>) => ManagedStream<T>;
  readonly clock: () => number;
}

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
type ProducerHooks = Pick<StreamHooks, 'pull' | 'seal' | 'finish'> & {
  readonly end: (stream: Resource, failure: StreamFailure | undefined) => void;
};

class Finalization {
  readonly deferred = new Set<{ abort(error: unknown): void }>();
  readonly #abort = new AbortController();
  readonly signal = this.#abort.signal;
  #expired = false;

  get expired(): boolean { return this.#expired; }

  async join(work: Promise<Failure | undefined>): Promise<Failure | undefined> {
    if (this.signal.aborted) return { reason: this.signal.reason };
    const timedOut = Promise.withResolvers<Failure>();
    const expire = (): void => timedOut.resolve({ reason: this.signal.reason });
    this.signal.addEventListener('abort', expire, { once: true });
    try {
      return await Promise.race([work, timedOut.promise]);
    } finally {
      this.signal.removeEventListener('abort', expire);
    }
  }

  async afterDelivery(work: Promise<Failure | undefined>, timeoutMs: number): Promise<Failure | undefined> {
    const timer = setTimeout(() => {
      const reason = new FinalizationTimeoutError(timeoutMs);
      this.#expired = true;
      for (const deferred of this.deferred) deferred.abort(reason);
      this.#abort.abort(reason);
    }, timeoutMs);
    try {
      return await this.join(work);
    } finally {
      clearTimeout(timer);
    }
  }
}

class RunState {
  readonly work = new Set<Promise<unknown>>();
  readonly errors: unknown[] = [];
  readonly signal: AbortSignal;

  constructor(readonly trace: Trace, readonly runId: string, readonly options: RunOptions<any>, readonly finalization: Finalization) {
    this.signal = options.signal ? AbortSignal.any([options.signal, finalization.signal]) : finalization.signal;
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
    const resource = new DeferredResource<T>(name, this.trace, stageId, () => this.finalization.expired);
    this.finalization.deferred.add(resource);
    const work = resource.handle.deferred.promise;
    void this.track(work);
    const remove = (): void => { this.finalization.deferred.delete(resource); };
    void work.then(remove, remove);
    return resource;
  }

  async finish(result: Promise<Facts>, root: boolean): Promise<Failure | undefined> {
    const joined = async (): Promise<Failure | undefined> => {
      while (this.work.size) await Promise.allSettled(this.work);
      return this.errors.length ? { reason: combineErrors(this.errors, 'Pipeline run failed') } : undefined;
    };
    const delivered = async (): Promise<Failure | undefined> => {
      const [settled] = await Promise.allSettled([result]);
      if (settled.status === 'fulfilled') {
        await Promise.all([...collectStreams(settled.value)].map(stream => resourceOf(stream).ended));
      } else {
        this.errors.unshift(settled.reason);
      }
      const work = joined();
      return root ? await this.finalization.afterDelivery(work, this.options.finalizationTimeoutMs) : await work;
    };
    return root ? await delivered() : await this.finalization.join(delivered());
  }
}

interface ChildDomain {
  readonly signal: AbortSignal;
  readonly settle: () => void;
}

class InvocationCustody extends Custody {
  readonly #pending = new Set<Promise<unknown>>();
  readonly #closed = new Set<Promise<unknown>>();

  childDomain(signal?: AbortSignal): ChildDomain {
    return { signal: signal ? AbortSignal.any([this.signal, signal]) : this.signal, settle: () => undefined };
  }

  track<T>(result: Promise<T>, closed: Promise<unknown>): Promise<T> {
    this.#pending.add(result);
    this.#closed.add(closed);
    const finished = (): void => { this.#pending.delete(result); };
    void result.then(finished, finished);
    const drained = (): void => { this.#closed.delete(closed); };
    void closed.then(drained, drained);
    return result;
  }

  async release(): Promise<void> {
    if (this.#pending.size) await Promise.allSettled(this.#pending);
    await this.cleanup();
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
  readonly #calls = new Set<AbortController>();
  #sealed = false;

  constructor(stageName: string, parentSignal: AbortSignal) {
    const abort = new AbortController();
    const stopReading = new AbortController();
    super(stageName, AbortSignal.any([abort.signal, parentSignal]), stopReading.signal);
    this.#abort = abort;
    this.#stopReading = stopReading;
  }

  get sealed(): boolean { return this.#sealed; }

  override childDomain(signal?: AbortSignal): ChildDomain {
    const cancel = new AbortController();
    this.#calls.add(cancel);
    return {
      signal: AbortSignal.any(signal ? [this.signal, cancel.signal, signal] : [this.signal, cancel.signal]),
      settle: () => { this.#calls.delete(cancel); },
    };
  }

  seal(end: StreamEnd): void {
    this.#sealed = true;
    this.#stopReading.abort();
    if (end.how === 'cancelled') this.#abort.abort(end.reason);
    if (end.how !== 'exhausted') {
      const reason = end.how === 'cancelled' ? end.reason : end.how === 'errored' ? end.error : undefined;
      for (const call of this.#calls) call.abort(reason);
    }
  }
}

const createRuntimeStream = <T>(
  state: RunState,
  stageId: number,
  owner: Custody,
  options: CreateStreamOptions<T>,
  inners: readonly Resource[] = [],
  producer?: ProducerHooks,
): StreamResource<T> => {
  const { trace } = state;
  const streamId = trace.streamId();
  const resource = new StreamResource(owner, {
    membership: trace.membership,
    id: streamId,
    pull: stream => producer?.pull(stream),
    seal: (stream, end) => producer?.seal(stream, end),
    finish: stream => producer?.finish(stream),
    frame: value => trace.emit({ k: 'frame', streamId, value }),
    end: (end, diagnostic, failure) => {
      trace.emit({ k: 'end', streamId, how: end.how, ...(diagnostic ? { error: trace.snapshot(diagnostic.reason) } : {}) });
      if (failure) state.errors.push(failure.reason);
      producer?.end(resource, failure);
    },
  }, options, inners);
  void state.track(resource.completion, false);
  trace.emit({ k: 'stream', streamId, stageId, label: options.label, ...(inners.length ? { wraps: inners.map(inner => inner.id) } : {}) });
  return resource;
};

class Scope {
  readonly finished: Promise<void>;
  readonly custody: InvocationCustody;
  readonly #closed = Promise.withResolvers<void>();
  readonly #ownedDeferreds = new Set<{ ownerEnded(): OwnerDeferredFailure | undefined }>();
  readonly #created = new Set<Resource>();
  readonly #producers = new Map<Resource, Producer>();
  readonly #pulling = new Set<Producer>();
  readonly #failures: unknown[] = [];
  #phase: 'executing' | 'draining' | 'closed' = 'executing';
  #executionJoined = false;
  #completed = false;

  constructor(
    readonly state: RunState, readonly id: number, readonly name: string, readonly signal: AbortSignal,
  ) {
    this.custody = new InvocationCustody(name, signal);
    this.finished = state.track(this.#closed.promise, false);
  }

  admit(operation: string, executingOnly = false): InvocationCustody {
    if (this.state.finalization.expired || this.signal.aborted) throw new StageScopeClosedError(this.name, operation);
    if (this.#phase === 'executing') return this.custody;
    if (!executingOnly && this.#phase === 'draining' && this.#pulling.size === 1) {
      const [producer] = this.#pulling;
      if (!producer.sealed && !producer.signal.aborted) return producer;
    }
    throw new StageScopeClosedError(this.name, operation);
  }

  environment(): StageEnv<any> {
    const { state, id, name, signal } = this;
    const log = (level: LogLevel, message: string, fields?: Facts): void => {
      state.trace.emit({ k: 'log', stageId: id, level, message, ...(fields === undefined ? {} : { fields: freezeFacts(fields, 'log.fields', state.trace.membership) }) });
    };
    const wrapStream: StageEnv<any>['wrapStream'] = <Out>(
      inputs: ManagedStream<unknown> | Readonly<Record<string, ManagedStream<unknown>>>,
      options: WrapStreamOptions<any, Out> | WrapStreamsOptions<any, Out>,
    ): ManagedStream<Out> => {
      const custody = this.admit('wrapStream');
      const single = isManagedStream(inputs);
      const entries = (single ? [['', inputs] as const] : Object.entries(inputs)).map(([key, handle]) => [key, resourceOf(handle)] as const);
      const inners = new Set<Resource>();
      for (const [, inner] of entries) {
        inner.assertOwned(custody, 'wrapStream');
        if (inners.has(inner)) throw new StreamOwnershipError(inner.handle.label, 'wrapStream (duplicate input)');
        inners.add(inner);
      }
      const wrapped = single
        ? wrapOptions(entries[0][1], options as WrapStreamOptions<unknown, Out>)
        : wrapStreamsOptions(entries, options as WrapStreamsOptions<Record<string, unknown>, Out>);
      for (const inner of inners) inner.adopt();
      return this.#stream(custody, wrapped, [...inners]);
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
      wrapStream,
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
        const domain = custody.childDomain();
        const sub = startRun(pipeline, facts, { ...state.options, signal: domain.signal, runId: crypto.randomUUID() }, {
          trace: state.trace, finalization: state.finalization, caller: custody, parentStageId: id,
        });
        void sub.result.then(domain.settle, domain.settle);
        const joined = state.track(Promise.all([sub.done, sub.failure]).then(([, failure]) => {
          if (failure) throw failure.reason;
        }));
        return Object.freeze({ result: custody.track(sub.result, joined), done: sub.done });
      },
    });
  }

  #stream<T>(owner: InvocationCustody, options: CreateStreamOptions<T>, inners?: readonly Resource[]): ManagedStream<T> {
    const resource = createRuntimeStream(this.state, this.id, owner, options, inners, {
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
      end: (stream, failure) => {
        if (this.#producers.has(stream)) {
          if (failure) this.#failures.push(failure.reason);
          this.#producers.delete(stream);
          this.#completeIfDrained();
        }
      },
    });
    if (owner === this.custody) this.#created.add(resource);
    return resource.handle;
  }

  answer(facts: Facts, recipient: Custody, baseChildId: number | undefined): void {
    const handoff = ownedStreams(facts, this.custody, 'return');
    this.signal.throwIfAborted();
    for (const stream of handoff) {
      if (this.#created.has(stream)) this.#producers.set(stream, new Producer(this.name, this.signal));
    }
    this.#created.clear();
    this.#phase = this.#producers.size ? 'draining' : 'closed';
    for (const stream of handoff) stream.move(recipient);
    this.state.trace.emit({ k: 'leave', stageId: this.id, facts, ...(baseChildId === undefined ? {} : { baseChildId }) });
    this.#closeExecution();
  }

  fail(error: unknown, facts: Facts): void {
    this.#phase = 'closed';
    this.#created.clear();
    this.#failures.push(error);
    this.state.trace.emit({ k: 'fail', stageId: this.id, error: this.state.trace.snapshot(error), facts });
    this.#closeExecution();
  }

  #closeExecution(): void {
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
    for (const deferred of this.#ownedDeferreds) {
      const failure = deferred.ownerEnded();
      if (failure) this.#failures.push(failure.error);
    }
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
  readonly result: Promise<Facts>;
  readonly closed: Promise<void>;
}

interface Caller {
  readonly custody: Custody;
  readonly recipient?: Custody;
  readonly edge: StageEdge;
  readonly stageId: number | null;
  readonly childId: number;
  readonly signal: AbortSignal;
}

const invoke = (
  state: RunState, pipeline: AnyPipeline, assembly: ReturnType<typeof assemblyOf>, index: number, facts: Facts, caller: Caller,
): Child => {
  const step = index < assembly.stages.length ? assembly.stages[index] : assembly.ending;
  const id = caller.childId;
  const { membership } = state.trace;
  const scope = new Scope(state, id, step.name, caller.signal);
  const answers = new Set<Answer>();

  const runChild = (
    target: AnyPipeline, targetAssembly: ReturnType<typeof assemblyOf>, targetIndex: number, handed: Facts,
    custody: InvocationCustody, edge: 'next' | 'into', declaration: SideDecl, options?: ChildOptions,
  ): Promise<Facts> => {
    const childId = state.trace.stageId();
    const answer: Answer = { id: childId, declaration };
    answers.add(answer);
    const domain = custody.childDomain(options?.signal);
    const child = invoke(state, target, targetAssembly, targetIndex, handed, { custody, edge, stageId: id, childId, signal: domain.signal });
    const result = child.result.then(back => {
      requireKeys(step.name, 'up', back, declaration.needs);
      answer.facts = back;
      return back;
    });
    void result.then(domain.settle, () => {
      answers.delete(answer);
      domain.settle();
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

      if (step.kind === 'stage') {
        const through = step.through;
        if (through) {
          requireKeys(step.name, 'entry', facts, through.request.needs);
          const next = (input: Facts, options?: ChildOptions): Promise<Facts> => {
            const custody = scope.admit('next');
            const handed = freezeFacts(input, `${step.name}.next`, membership);
            checkDown(step.name, facts, handed, through.request);
            return runChild(pipeline, assembly, index + 1, handed, custody, 'next', through.response, options);
          };
          output = freezeFacts(await step.execute(facts, next, env), `${step.name}.return`, membership);
        } else {
          output = freezeFacts(await step.execute(facts, env), `${step.name}.return`, membership);
        }
      } else {
        requireKeys(step.name, 'entry', facts, step.request.needs);
        const into: Record<string, ((...args: any[]) => Promise<Facts>)> = Object.create(null);
        const enter = (slot: Slot, key: unknown, input: unknown, declaration: ThroughDecl, options?: ChildOptions): Promise<Facts> => {
          const custody = scope.admit('into');
          const handed = freezeFacts(input, `${step.name}.into`, membership);
          requireKeys(step.name, 'entry', facts, declaration.request.needs);
          checkDown(step.name, facts, handed, declaration.request);
          const target = resolveSlot(slot, key, state.options.services);
          return runChild(target, checkLinked(target), 0, handed, custody, 'into', declaration.response, options);
        };
        for (const [key, slot] of Object.entries(assembly.targets)) {
          const declaration = step.into![key];
          into[key] = 'resolve' in slot
            ? (key: unknown, input: unknown, options?: ChildOptions) => enter(slot, key, input, declaration, options)
            : (input: unknown, options?: ChildOptions) => enter(slot, undefined, input, declaration, options);
        }
        output = freezeFacts(await step.execute(facts, Object.freeze(into), env), `${step.name}.return`, membership);
      }

      const base = checkUp(step.name, step.return, output, answers);
      scope.answer(output, caller.recipient ?? caller.custody, base);
      return output;
    } catch (error) {
      scope.fail(error, facts);
      throw error;
    }
  };
  return { result: state.track(execute(), false), closed: scope.finished };
};

interface Subrun {
  readonly trace: Trace;
  readonly finalization: Finalization;
  readonly caller: Custody;
  readonly parentStageId: number;
}

const startRun = <I, O, S>(pipeline: Pipeline<I, O, S>, input: I | ((root: RootEnv) => I), options: RunOptions<any>, sub?: Subrun): RunHandle<O> & {
  readonly failure: Promise<Failure | undefined>;
} => {
  if (!Number.isFinite(options.finalizationTimeoutMs) || options.finalizationTimeoutMs < 0) {
    throw new RangeError('finalizationTimeoutMs must be a nonnegative finite number');
  }
  const start = performance.now();
  const trace = sub?.trace ?? new Trace(options.clock ?? (() => performance.now() - start), options.events);
  const state = new RunState(trace, options.runId ?? crypto.randomUUID(), options, sub?.finalization ?? new Finalization());
  if (!sub) trace.emit({ k: 'run', runId: state.runId, pipeline: pipeline.name, startedAt: Date.now() });
  const execute = async (): Promise<Facts> => {
    const assembly = checkLinked(pipeline);
    state.signal.throwIfAborted();
    const childId = trace.stageId();
    if (sub) {
      const facts = freezeFacts(input, `${pipeline.name}.input`, trace.membership);
      return await invoke(state, pipeline, assembly, 0, facts, {
        custody: sub.caller, edge: 'subrun', stageId: sub.parentStageId, childId, signal: state.signal,
      }).result;
    }

    const custody = new Custody(pipeline.name, state.signal);
    const recipient = new Custody(pipeline.name, state.signal);
    let open = true;
    let child: Child;
    try {
      const root: RootEnv = Object.freeze({
        clock: trace.clock,
        createStream: <T>(options: CreateStreamOptions<T>): ManagedStream<T> => {
          if (!open || state.signal.aborted) throw new StageScopeClosedError(pipeline.name, 'root.createStream');
          return createRuntimeStream(state, childId, custody, options).handle;
        },
      });
      const value = typeof input === 'function' ? (input as (root: RootEnv) => I)(root) : input;
      open = false;
      const facts = freezeFacts(value, `${pipeline.name}.input`, trace.membership);
      child = invoke(state, pipeline, assembly, 0, facts, {
        custody, recipient, edge: 'root', stageId: null, childId, signal: state.signal,
      });
    } finally {
      open = false;
      void state.track(custody.cleanup());
    }
    return await child.result;
  };
  const result = execute();
  const failure = state.finish(result, sub === undefined);
  const done = failure.then(failure => {
    const completion: RunDone = failure ? { ok: false, error: trace.snapshot(failure.reason) } : { ok: true };
    if (!sub) trace.emit({ k: 'done', ...completion });
    return Object.freeze(completion);
  });
  return { result: result as Promise<Facts & O>, done, failure };
};

export const run = <I, O, S>(pipeline: Pipeline<I, O, S>, input: I | ((root: RootEnv) => I), options: RunOptions<S>): RunHandle<O> => {
  const { result, done } = startRun(pipeline, input, options);
  return Object.freeze({ result, done });
};
