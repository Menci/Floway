import { assemblyOf } from './compose.ts';
import type { IntoMap, Pipeline, TargetMap } from './compose.ts';
import { checkDown, checkUp, requireKeys } from './declarations.ts';
import type { Answer } from './declarations.ts';
import { DeferredResource } from './deferred.ts';
import { FinalizationTimeoutError, StageScopeClosedError, StreamOwnershipError } from './errors.ts';
import { Trace } from './events.ts';
import type { RunEventSink, StageEdge } from './events.ts';
import { collectStreams, freezeFacts } from './facts.ts';
import type { Facts } from './facts.ts';
import { isManagedStream } from './handles.ts';
import type { Deferred, DeferredHandle, ManagedStream } from './handles.ts';
import type { ErrorSnapshot } from './snapshot-error.ts';
import type { ChildOptions, EndingScope, LogLevel, Next, Scope, SideDecl, StageScope } from './stage.ts';
import { StopDomain } from './stop.ts';
import type { Stop } from './stop.ts';
import { combineErrors, Custody, resourceOf, StreamResource, wrapOptions, wrapStreamsOptions } from './stream.ts';
import type { CreateStreamOptions, ResourceOptions, StreamEnd, StreamFailure, WrapStreamOptions, WrapStreamsOptions } from './stream.ts';

export interface RootStreamScope {
  readonly signal: AbortSignal;
  readonly clock: () => number;
}

export interface RootEnv {
  readonly createStream: <T>(options: CreateStreamOptions<T, RootStreamScope>) => ManagedStream<T>;
  readonly clock: () => number;
}

export interface RunOptions<S> {
  readonly services: S;
  readonly signal?: AbortSignal;
  readonly events?: RunEventSink;
  readonly onSinkError?: (error: unknown) => void;
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
  readonly diagnostics?: readonly ErrorSnapshot[];
}

type AnyPipeline = Pipeline<any, any, any>;
type Resource = StreamResource<unknown>;
type Failure = { readonly reason: unknown };

const cancellation = (stop: Stop | undefined, error: unknown): Stop | undefined =>
  stop?.kind === 'cancel' && Object.is(stop.reason, error) ? stop : undefined;

class Finalization {
  readonly deferred = new Set<{ abort(error: unknown): void }>();
  readonly domain = new StopDomain();

  get expired(): boolean { return this.domain.stop !== undefined; }

  async join(work: Promise<Failure | undefined>): Promise<Failure | undefined> {
    const { signal } = this.domain;
    if (signal.aborted) return { reason: signal.reason };
    const timedOut = Promise.withResolvers<Failure>();
    const expire = (): void => timedOut.resolve({ reason: signal.reason });
    signal.addEventListener('abort', expire, { once: true });
    try {
      return await Promise.race([work, timedOut.promise]);
    } finally {
      signal.removeEventListener('abort', expire);
    }
  }

  async afterDelivery(work: Promise<Failure | undefined>, timeoutMs: number): Promise<Failure | undefined> {
    const timer = setTimeout(() => {
      const reason = new FinalizationTimeoutError(timeoutMs);
      this.domain.abort({ kind: 'timeout', reason });
      for (const deferred of this.deferred) deferred.abort(reason);
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

  constructor(
    readonly trace: Trace, readonly runId: string, readonly options: RunOptions<any>,
    readonly finalization: Finalization,
  ) {}

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
      }
      const work = joined();
      return root ? await this.finalization.afterDelivery(work, this.options.finalizationTimeoutMs) : await work;
    };
    return root ? await delivered() : await this.finalization.join(delivered());
  }
}

interface ProducerHooks {
  readonly interruption: (error: unknown) => Stop | undefined;
  readonly seal: (end: StreamEnd, stop?: Stop) => void;
  readonly finish: () => Promise<void>;
  readonly end: (stream: Resource, failure: StreamFailure | undefined) => void;
}

const createRuntimeStream = <T>(
  state: RunState, stageId: number, owner: Custody, options: ResourceOptions<T>,
  inners: readonly Resource[] = [], producer?: ProducerHooks,
): StreamResource<T> => {
  const { trace } = state;
  const streamId = trace.streamId();
  const resource = new StreamResource(owner, {
    membership: trace.membership,
    id: streamId,
    interruption: error => producer?.interruption(error),
    seal: (end, stop) => producer?.seal(end, stop),
    finish: () => producer?.finish(),
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

type Calls = { readonly next?: Next<Facts, Facts>; readonly into?: IntoMap<TargetMap> };
type RuntimeScope = Scope<any> & Calls;

class Invocation extends Custody {
  readonly #pending = new Map<StopDomain, Promise<unknown>>();
  readonly #children = new Map<StopDomain, Promise<unknown>>();
  readonly #cancellations = new Map<unknown, Stop>();
  #sealed = false;
  #released: Stop | undefined;

  constructor(
    readonly stage: StageExecution, domain: StopDomain, readonly readStop?: AbortController,
  ) {
    super(stage.name, domain, readStop?.signal);
  }

  admit(operation: string): void {
    if (this.#sealed || this.domain.stop) throw new StageScopeClosedError(this.stage.name, operation);
  }

  interruption(error: unknown): Stop | undefined {
    return cancellation(this.domain.stop, error) ?? this.#cancellations.get(error);
  }

  child<I>(domain: StopDomain, result: Promise<I>, closed: Promise<unknown>, interruption: () => Stop | undefined): Promise<I> {
    const observed = result.then(value => value, (error: unknown) => {
      const stop = interruption();
      if (stop) this.#cancellations.set(error, stop);
      throw error;
    });
    this.#pending.set(domain, observed);
    this.#children.set(domain, closed);
    const returned = (): void => { this.#pending.delete(domain); };
    void observed.then(returned, returned);
    const drained = (): void => { this.#children.delete(domain); };
    void closed.then(drained, drained);
    return observed;
  }

  seal(stop?: Stop): void {
    this.#sealed = true;
    this.readStop?.abort();
    if (stop) this.domain.abort(stop);
  }

  sealProducer(end: StreamEnd, stop?: Stop): void {
    if (end.how === 'errored') {
      this.seal(stop ?? { kind: 'panic', reason: end.error });
    } else if (end.how === 'cancelled') {
      this.seal(stop ?? { kind: 'cancel', reason: end.reason });
    } else {
      this.seal();
      if (end.how !== 'exhausted') {
        const released = { kind: 'cancel', reason: new DOMException('The producer released its stream', 'AbortError') } satisfies Stop;
        this.#released = released;
        for (const domain of this.#pending.keys()) domain.abort(released);
      }
    }
  }

  async finish(normal: boolean, joinChildren: boolean): Promise<void> {
    try {
      if (this.#pending.size) await Promise.allSettled(this.#pending.values());
      if (normal && !this.domain.stop && !this.#released) await this.cleanup();
      else await this.drop();
    } finally {
      const released = this.#released;
      // Child streams already returned to this producer retain layer-by-layer release.
      if (released) {
        for (const domain of this.#children.keys()) domain.abort(released);
      }
      if (joinChildren && this.#children.size) await Promise.allSettled(this.#children.values());
    }
  }

  scope(signal: AbortSignal): RuntimeScope {
    const { stage } = this;
    const { state, id, name, log } = stage;
    const wrapStream: Scope<any>['wrapStream'] = <Out>(
      inputs: ManagedStream<unknown> | Readonly<Record<string, ManagedStream<unknown>>>,
      options: WrapStreamOptions<any, Out> | WrapStreamsOptions<any, Out>,
    ): ManagedStream<Out> => {
      this.admit('wrapStream');
      const single = isManagedStream(inputs);
      const entries = (single ? [['', inputs] as const] : Object.entries(inputs)).map(([key, handle]) => [key, resourceOf(handle)] as const);
      const inners = new Set<Resource>();
      for (const [, inner] of entries) {
        inner.assertOwned(this, 'wrapStream');
        if (inners.has(inner)) throw new StreamOwnershipError(inner.handle.label, 'wrapStream (duplicate input)');
        inners.add(inner);
      }
      const producer = this.#producer();
      const scopeFor = (signal: AbortSignal): RuntimeScope => producer.scope(signal);
      const wrapped = single
        ? wrapOptions(entries[0][1], options as WrapStreamOptions<unknown, Out>, scopeFor)
        : wrapStreamsOptions(entries, options as WrapStreamsOptions<Record<string, unknown>, Out>, scopeFor);
      for (const inner of inners) inner.adopt();
      return this.#stream(producer, wrapped, [...inners]);
    };
    return Object.freeze({
      runId: state.runId,
      stageId: id,
      stageName: name,
      signal,
      clock: state.trace.clock,
      log,
      services: state.options.services,
      ...stage.calls(this),
      createStream: <T>(options: CreateStreamOptions<T>): ManagedStream<T> => {
        this.admit('createStream');
        const producer = this.#producer();
        return this.#stream(producer, { ...options, iterate: ({ signal }) => options.iterate(producer.scope(signal)) });
      },
      wrapStream,
      defer: <T>(name: string, work: Promise<T>): Deferred<T> => {
        this.admit('defer');
        const deferred = state.admitDeferred<T>(name, id);
        deferred.attach(work);
        return deferred.handle.deferred;
      },
      deferred: <T>(name: string, owner: ManagedStream<unknown>): DeferredHandle<T> => {
        this.admit('deferred');
        const stream = resourceOf(owner);
        stream.assertOwned(this, 'deferred');
        const deferred = state.admitDeferred<T>(name, id);
        stream.bindDeferred(() => deferred.ownerEnded());
        return deferred.handle;
      },
      run: <I, O, S>(pipeline: Pipeline<I, O, S>, facts: I): RunHandle<O> => {
        this.admit('run');
        const domain = new StopDomain(this.domain);
        const sub = startRun(pipeline, facts, { ...state.options, runId: crypto.randomUUID() }, {
          trace: state.trace, finalization: state.finalization, caller: this, domain, parentStageId: id,
        });
        const joined = state.track(sub.failure.then(failure => {
          if (failure) throw failure.reason;
        }));
        return Object.freeze({ result: this.child(domain, sub.result, joined, sub.interruption), done: sub.done });
      },
    });
  }

  #producer(): Invocation {
    return new Invocation(this.stage, new StopDomain(this.domain), new AbortController());
  }

  #stream<T>(producer: Invocation, options: ResourceOptions<T>, inners?: readonly Resource[]): ManagedStream<T> {
    const { stage } = this;
    const resource = createRuntimeStream(stage.state, stage.id, this, options, inners, {
      interruption: error => producer.interruption(error),
      seal: (end, stop) => producer.sealProducer(end, stop),
      finish: () => producer.finish(true, true),
      end: (stream, failure) => stage.streamEnded(stream, failure),
    });
    stage.streamCreated(resource);
    return resource.handle;
  }
}

class StageExecution {
  readonly outer: Invocation;
  readonly log: Scope['log'];
  readonly finished: Promise<void>;
  readonly #closed = Promise.withResolvers<void>();
  readonly #streams = new Set<Resource>();
  readonly #failures: unknown[] = [];
  #cleaned = false;

  constructor(
    readonly state: RunState, readonly id: number, readonly name: string,
    domain: StopDomain, readonly calls: (owner: Invocation) => Calls,
  ) {
    this.outer = new Invocation(this, new StopDomain(domain));
    this.finished = state.track(this.#closed.promise, false);
    const emit = (level: LogLevel, message: string, fields?: Facts): void => {
      state.trace.emit({ k: 'log', stageId: id, level, message, ...(fields === undefined ? {} : { fields: freezeFacts(fields, 'log.fields', state.trace.membership) }) });
    };
    this.log = Object.freeze({
      debug: (message: string, fields?: Facts) => emit('debug', message, fields),
      info: (message: string, fields?: Facts) => emit('info', message, fields),
      warn: (message: string, fields?: Facts) => emit('warn', message, fields),
      error: (message: string, fields?: Facts) => emit('error', message, fields),
    });
  }

  streamCreated(stream: Resource): void { this.#streams.add(stream); }

  streamEnded(stream: Resource, failure: StreamFailure | undefined): void {
    if (failure) this.#failures.push(failure.reason);
    this.#streams.delete(stream);
    this.#complete();
  }

  answer(facts: Facts, recipient: Custody, baseChildId: number | undefined): void {
    const handoff = ownedStreams(facts, this.outer, 'return');
    this.outer.domain.signal.throwIfAborted();
    for (const stream of handoff) stream.move(recipient);
    this.state.trace.emit({ k: 'leave', stageId: this.id, facts, ...(baseChildId === undefined ? {} : { baseChildId }) });
    this.#cleanup(true);
  }

  fail(error: unknown, facts: Facts, interrupted?: Stop): void {
    if (interrupted) {
      this.outer.seal(interrupted);
    } else {
      this.state.trace.emit({ k: 'fail', stageId: this.id, error: this.state.trace.snapshot(error), facts });
      this.#failures.push(error);
      this.state.errors.push(error);
      this.outer.seal({ kind: 'panic', reason: error });
    }
    this.#cleanup(false);
  }

  #cleanup(normal: boolean): void {
    const finish = (): void => {
      this.#cleaned = true;
      this.#complete();
    };
    void this.outer.finish(normal, false).then(finish, error => {
      this.#failures.push(error);
      this.state.errors.push(error);
      finish();
    });
  }

  #complete(): void {
    if (!this.#cleaned || this.#streams.size) return;
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
  if (!assembly.linkedTargets && assembly.targets.length) throw new Error(`Pipeline "${pipeline.name}" has unlinked targets`);
  return assembly;
};

interface Child {
  readonly result: Promise<Facts>;
  readonly closed: Promise<void>;
  readonly interruption: () => Stop | undefined;
}

interface Caller {
  readonly custody: Custody;
  readonly recipient?: Custody;
  readonly edge: StageEdge;
  readonly stageId: number | null;
  readonly childId: number;
  readonly domain: StopDomain;
}

const invoke = (
  state: RunState, pipeline: AnyPipeline, assembly: ReturnType<typeof assemblyOf>, index: number, facts: Facts, caller: Caller,
): Child => {
  const step = index < assembly.stages.length ? assembly.stages[index] : assembly.ending;
  const id = caller.childId;
  const { membership } = state.trace;
  const answers = new Set<Answer>();
  let interrupted: Stop | undefined;

  const runChild = (
    owner: Invocation, target: AnyPipeline, targetAssembly: ReturnType<typeof assemblyOf>, targetIndex: number, handed: Facts,
    edge: 'next' | 'into', declaration: SideDecl, options?: ChildOptions,
  ): Promise<Facts> => {
    const childId = state.trace.stageId();
    const answer: Answer = { id: childId, declaration };
    answers.add(answer);
    const domain = new StopDomain(owner.domain, options?.signal);
    const child = invoke(state, target, targetAssembly, targetIndex, handed, { custody: owner, edge, stageId: id, childId, domain });
    const result = child.result.then(back => {
      requireKeys(step.name, 'up', back, declaration.needs);
      answer.facts = back;
      return back;
    });
    return owner.child(domain, result, child.closed, child.interruption);
  };

  const calls = (owner: Invocation): Calls => {
    if (step.kind === 'stage') {
      const through = step.through;
      if (!through) return {};
      return {
        next: (input, options) => {
          owner.admit('next');
          const handed = freezeFacts(input, `${step.name}.next`, membership);
          checkDown(step.name, facts, handed, through.request);
          return runChild(owner, pipeline, assembly, index + 1, handed, 'next', through.response, options);
        },
      };
    }
    const into: Record<string, Next<Facts, Facts>> = Object.create(null);
    for (const { name, declaration, pipeline: target } of assembly.linkedTargets ?? []) {
      into[name] = (input, options) => {
        owner.admit('into');
        const handed = freezeFacts(input, `${step.name}.into`, membership);
        requireKeys(step.name, 'entry', facts, declaration.request.needs);
        checkDown(step.name, facts, handed, declaration.request);
        return runChild(owner, target, checkLinked(target), 0, handed, 'into', declaration.response, options);
      };
    }
    return { into: Object.freeze(into) };
  };

  const stage = new StageExecution(state, id, step.name, caller.domain, calls);
  const { outer } = stage;
  const execute = async (): Promise<Facts> => {
    state.trace.emit({ k: 'enter', stageId: id, parentStageId: caller.stageId, edge: caller.edge, pipeline: pipeline.name, name: step.name, facts });
    try {
      outer.domain.signal.throwIfAborted();
      for (const stream of ownedStreams(facts, caller.custody, 'request transfer')) stream.move(outer);
      if (index === 0) requireKeys(step.name, 'entry', facts, pipeline.entry);
      const scope = outer.scope(outer.domain.signal);
      let value: Facts;
      try {
        if (step.kind === 'ending') {
          requireKeys(step.name, 'entry', facts, step.request.needs);
          value = await step.execute(facts, scope as EndingScope<TargetMap, any>);
        } else if (step.through) {
          requireKeys(step.name, 'entry', facts, step.through.request.needs);
          value = await step.execute(facts, scope as StageScope<Facts, Facts, any>);
        } else {
          value = await step.execute(facts, scope);
        }
      } finally {
        outer.seal();
      }
      outer.domain.signal.throwIfAborted();
      const output = freezeFacts(value, `${step.name}.return`, membership);
      const base = checkUp(step.name, step.return, output, answers);
      if (index === 0) requireKeys(step.name, 'up', output, pipeline.exit);
      stage.answer(output, caller.recipient ?? caller.custody, base);
      return output;
    } catch (error) {
      interrupted = outer.interruption(error);
      stage.fail(error, facts, interrupted);
      throw error;
    }
  };
  return { result: state.track(execute(), false), closed: stage.finished, interruption: () => interrupted };
};

interface Subrun {
  readonly trace: Trace;
  readonly finalization: Finalization;
  readonly caller: Custody;
  readonly domain: StopDomain;
  readonly parentStageId: number;
}

const startRun = <I, O, S>(pipeline: Pipeline<I, O, S>, input: I | ((root: RootEnv) => I), options: RunOptions<any>, sub?: Subrun): RunHandle<O> & {
  readonly failure: Promise<Failure | undefined>;
  readonly interruption: () => Stop | undefined;
} => {
  if (!Number.isFinite(options.finalizationTimeoutMs) || options.finalizationTimeoutMs < 0) {
    throw new RangeError('finalizationTimeoutMs must be a nonnegative finite number');
  }
  const start = performance.now();
  const trace = sub?.trace ?? new Trace(options.clock ?? (() => performance.now() - start), options.events, options.onSinkError);
  const finalization = sub?.finalization ?? new Finalization();
  const domain = sub?.domain ?? new StopDomain(finalization.domain, options.signal);
  const state = new RunState(trace, options.runId ?? crypto.randomUUID(), options, finalization);
  if (!sub) trace.emit({ k: 'run', runId: state.runId, pipeline: pipeline.name, startedAt: Date.now() });
  let interrupted: Stop | undefined;

  const execute = async (): Promise<Facts> => {
    let child: Child | undefined;
    try {
      const assembly = checkLinked(pipeline);
      domain.signal.throwIfAborted();
      const childId = trace.stageId();
      if (sub) {
        const facts = freezeFacts(input, `${pipeline.name}.input`, trace.membership);
        child = invoke(state, pipeline, assembly, 0, facts, {
          custody: sub.caller, edge: 'subrun', stageId: sub.parentStageId, childId, domain,
        });
      } else {
        const custody = new Custody(pipeline.name, domain);
        const recipient = new Custody(pipeline.name, domain);
        let open = true;
        try {
          const root: RootEnv = Object.freeze({
            clock: trace.clock,
            createStream: <T>(options: CreateStreamOptions<T, RootStreamScope>): ManagedStream<T> => {
              if (!open || domain.stop) throw new StageScopeClosedError(pipeline.name, 'root.createStream');
              return createRuntimeStream(state, childId, custody, {
                ...options, iterate: ({ signal }) => options.iterate(Object.freeze({ signal, clock: trace.clock })),
              }).handle;
            },
          });
          const value = typeof input === 'function' ? (input as (root: RootEnv) => I)(root) : input;
          open = false;
          const facts = freezeFacts(value, `${pipeline.name}.input`, trace.membership);
          child = invoke(state, pipeline, assembly, 0, facts, { custody, recipient, edge: 'root', stageId: null, childId, domain });
        } finally {
          open = false;
          void state.track(child && !domain.stop ? custody.cleanup() : custody.drop());
        }
      }
      return await child.result;
    } catch (error) {
      interrupted = child?.interruption() ?? cancellation(domain.stop, error);
      if (!child && !interrupted) state.errors.push(error);
      throw error;
    }
  };
  const result = execute();
  const failure = state.finish(result, sub === undefined);
  const done = failure.then(failure => {
    const completion: RunDone = failure ? { ok: false, error: trace.snapshot(failure.reason) } : { ok: true };
    if (!sub) trace.emit({ k: 'done', ...completion });
    return Object.freeze({
      ...completion, ...(trace.diagnostics.length ? { diagnostics: Object.freeze([...trace.diagnostics]) } : {}),
    });
  });
  return { result: result as Promise<Facts & O>, done, failure, interruption: () => interrupted };
};

export const run = <I, O, S>(pipeline: Pipeline<I, O, S>, input: I | ((root: RootEnv) => I), options: RunOptions<S>): RunHandle<O> => {
  const { result, done } = startRun(pipeline, input, options);
  return Object.freeze({ result, done });
};
