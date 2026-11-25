import { createLogg, getGlobalHookPostLog } from '@guiiai/logg';
import type { Log, Logg } from '@guiiai/logg';

import { assemblyOf, linkTargets } from './compose.ts';
import type { Assembly, Pipeline } from './compose.ts';
import { checkHandoff, checkReturn, checkUp, requireKeys } from './declarations.ts';
import type { ParsedSide, ParsedThrough } from './declarations.ts';
import type { RunEvent } from './events.ts';
import { checkFacts, registerHandle } from './facts.ts';
import type { Facts } from './facts.ts';
import { resourceOf, StreamResource, streamsIn, transferStreams } from './stream.ts';
import type { AnyStream, StreamOwner } from './stream.ts';
import type { Deferred, DeferredController, ManagedStream, Result } from './values.ts';

type AnyPipeline = Pipeline<never, unknown, never>;
type Failure = { readonly error: unknown };

interface RunOptions<S> {
  readonly services: S;
  readonly signal?: AbortSignal;
  readonly events?: (event: RunEvent) => void;
}

interface RunHandle<O> {
  readonly result: Promise<O>;
  readonly done: Promise<void>;
}

class SignalBranch {
  readonly #controller = new AbortController();
  readonly #children = new Set<SignalBranch>();
  #parent: SignalBranch | undefined;
  settled: (() => boolean) | undefined;

  constructor(parent?: SignalBranch) {
    this.#parent = parent;
    if (parent) parent.#children.add(this);
    if (parent?.signal.aborted) this.abort(parent.signal.reason);
  }

  get signal(): AbortSignal { return this.#controller.signal; }

  abort(reason?: unknown): void {
    if (this.settled?.()) {
      this.detach();
      return;
    }
    if (this.signal.aborted) return;
    this.#controller.abort(reason);
    for (const child of this.#children) child.abort(this.signal.reason);
  }

  detach(): void {
    if (this.#parent) this.#parent.#children.delete(this);
    this.#parent = undefined;
  }
}

class Runtime {
  readonly services: object;
  readonly stages = new Set<StageRun>();
  readonly signal = new SignalBranch();
  #id = 0;
  #failure: Failure | undefined;
  #deferredFailure: Failure | undefined;
  readonly #work = new Set<Promise<void>>();
  #finalized = false;

  constructor(readonly options: RunOptions<unknown>) {
    this.services = Object.freeze({ ...options.services as object });
  }

  stageId(): number { return ++this.#id; }

  emit(event: RunEvent): void {
    if (this.#finalized) return;
    try {
      this.options.events?.(event);
    } catch (error) {
      if (!this.#failure) throw error;
    }
  }

  panic(origin: StageRun, error: unknown): unknown {
    if (this.#failure) return this.#failure.error;
    for (const stage of this.stages) {
      if (stage !== origin) stage.settleIfReady();
    }
    const reason = origin.withLeaks(error);
    this.#failure = { error: reason };
    const reached = [...this.stages];
    this.stages.clear();
    for (const stage of reached) {
      stage.stop(stage === origin ? reason : stage.withLeaks(error));
    }
    this.signal.abort(reason);
    if (reached.includes(origin)) origin.recordPanic(reason, true);
    for (const stage of reached) {
      if (stage !== origin) stage.recordPanic(stage.panicReason!.error, false);
    }
    return reason;
  }

  defer(work: Promise<unknown>): void {
    const observed = work.then(() => undefined, error => { this.#deferredFailure ??= { error }; });
    this.#work.add(observed);
    void observed.then(() => { this.#work.delete(observed); });
  }

  async finalize(): Promise<void> {
    await Promise.all(this.#work);
    this.#finalized = true;
    if (this.#deferredFailure) throw this.#deferredFailure.error;
  }
}

class Call {
  readonly result: Promise<Facts>;
  readonly done: Promise<void>;
  readonly branch: SignalBranch;
  #active = true;
  #streams: ReadonlySet<AnyStream> | undefined;

  constructor(
    readonly stage: StageRun,
    accept: (facts: Facts) => void,
  ) {
    this.branch = stage.branch;
    this.branch.settled = () => this.settled;
    this.result = stage.result.then(facts => {
      this.#streams = streamsIn(facts);
      if (this.branch.settled?.()) this.#detach();
      accept(facts);
      return facts;
    });
    this.done = Promise.all([
      this.result.then(async () => { await Promise.all([...this.#streams!].map(stream => stream.done)); }),
      stage.done,
    ]).then(() => undefined).finally(() => { this.#detach(); });
    void this.done.catch(() => undefined);
  }

  get settled(): boolean {
    return this.#streams !== undefined && [...this.#streams].every(stream => stream.exhausted)
      && this.stage.settleIfReady();
  }

  abort(): void {
    if (this.#active) this.branch.abort();
  }

  #detach(): void {
    this.#active = false;
    this.branch.detach();
    this.branch.settled = undefined;
  }
}

type Producer<T, E> = (scope: never) => AsyncIterable<Result<T, E>>;
type Wrapper<T, E, U, F> = (source: AsyncIterable<Result<T, E>>, scope: never) => AsyncIterable<Result<U, F>>;
type Continuation = { readonly facts: Facts; readonly declaration: ParsedSide };
const ambiguous = Symbol('ambiguous answer');

const recordLogs = (logger: Logg, state: Runtime, stageId: number): Logg => {
  const hook = (log: Log, formatted: string): void => {
    getGlobalHookPostLog()?.(log, formatted);
    state.emit({ type: 'log', stageId, ...log });
  };
  // The declared instance hook has one parameter, but both logg output paths supply the formatted log.
  // https://github.com/guiiai/logg/blob/191ed0f6c763fd49d402a3f936b29e6322396782/src/logger.ts#L483-L526
  logger.withAfterLog(hook as (log: Log) => void);
  // Logg's child() copies the fields and configuration without the hook.
  // https://github.com/guiiai/logg/blob/191ed0f6c763fd49d402a3f936b29e6322396782/src/logger.ts#L296-L311
  const child = logger.child;
  logger.child = fields => recordLogs(child(fields), state, stageId);
  return logger;
};

class StageRun {
  readonly #id: number;
  readonly #owned: StreamOwner = new Set();
  readonly #produced = new Set<AnyStream>();
  readonly #calls = new Set<Call>();
  readonly #keys = new WeakMap<object, Call | typeof ambiguous>();
  readonly #continuations: Continuation[] = [];
  readonly #waitingForAnswers: Promise<Facts>[] = [];
  readonly #pendingDeferred = new Set<(error: unknown) => void>();
  readonly #answer = Promise.withResolvers<Facts>();
  readonly #settlement = Promise.withResolvers<void>();
  readonly #log: Logg;
  #latest: Facts;
  #executeOpen = true;
  #published = false;
  #settled = false;
  #leak: Error | undefined;
  #panic: Failure | undefined;

  constructor(
    readonly state: Runtime,
    readonly branch: SignalBranch,
    readonly assembly: Assembly,
    readonly position: number,
    readonly initial: Facts,
    readonly destination: StreamOwner,
    parentId?: number,
    readonly boundary?: Assembly,
  ) {
    this.#id = state.stageId();
    this.#latest = initial;
    const logger = createLogg(this.definition.name).useGlobalConfig();
    this.#log = state.options.events ? recordLogs(logger, state, this.#id) : logger;
    state.stages.add(this);
    void this.result.catch(() => undefined);
    void this.done.catch(() => undefined);
    try {
      state.emit({
        type: 'stage.entered',
        stageId: this.#id,
        name: this.definition.name,
        ...(parentId === undefined ? {} : { parentStageId: parentId }),
        facts: initial,
      });
    } catch (error) {
      state.panic(this, error);
    }
    void Promise.resolve().then(async () => await this.#execute()).catch(error => {
      state.panic(this, error);
    });
  }

  get result(): Promise<Facts> { return this.#answer.promise; }
  get done(): Promise<void> { return this.#settlement.promise; }
  get panicReason(): Failure | undefined { return this.#panic; }
  get definition() { return this.assembly.stages[this.position]; }

  settleIfReady(): boolean {
    if (this.#settled) return !this.#panic;
    if (!this.#published || this.#owned.size || this.#pendingDeferred.size
      || [...this.#produced].some(stream => !stream.exhausted)
      || [...this.#calls].some(call => !call.settled)) return false;
    this.#settled = true;
    this.state.stages.delete(this);
    this.#settlement.resolve();
    return true;
  }

  withLeaks(error: unknown): unknown {
    const leak = this.#leak ?? this.#abandonedStreams();
    return leak && leak !== error ? new AggregateError([error, leak], `Stage "${this.definition.name}" panicked and abandoned streams`) : error;
  }

  stop(error: unknown): void {
    this.#panic = { error };
    this.#settled = true;
    this.#executeOpen = false;
    for (const stream of this.#produced) stream.fail(error);
    for (const cancel of this.#pendingDeferred) cancel(error);
    this.#answer.reject(error);
    this.#settlement.reject(error);
  }

  recordPanic(error: unknown, original: boolean): void {
    this.state.emit({
      type: 'stage.panicked',
      stageId: this.#id,
      error,
      ...(original && { facts: this.#latest }),
    });
  }

  #fail(error: unknown): never {
    throw this.state.panic(this, error);
  }

  #abandonedStreams(): Error | undefined {
    return this.#owned.size
      ? new Error(`Stage "${this.definition.name}" abandoned ${this.#owned.size} owned stream(s)`)
      : undefined;
  }

  #checkOwned(): void {
    this.#leak = this.#abandonedStreams();
    if (this.#leak) throw this.#leak;
  }

  async #execute(): Promise<void> {
    if (this.#panic) return;
    const { initial, definition, boundary, state } = this;
    const where = `Stage "${definition.name}"`;
    checkFacts(initial, `${where} entry`);
    if (boundary) requireKeys(initial, boundary.entry, `${where} pipeline entry`);
    requireKeys(initial, definition.requestNeeds, `${where} request`);
    let answer: Facts;
    try {
      answer = await definition.execute(initial, this.#scope(() => this.#executeOpen) as never);
    } finally {
      this.#executeOpen = false;
    }
    if (this.#panic) return;
    this.#latest = answer;
    checkFacts(answer, `${where} response`);
    await Promise.all(this.#waitingForAnswers);
    if (this.#panic) return;
    if (this.#continuations.length) checkUp(answer, this.#continuations, `${where} response`);
    else checkReturn(answer, definition.answer, where);
    this.#continuations.length = 0;
    this.#waitingForAnswers.length = 0;
    if (boundary) requireKeys(answer, boundary.exit, `${where} pipeline exit`);

    transferStreams(streamsIn(answer), this.#owned, this.destination);
    const produced = [...this.#produced].filter(stream => stream.owner !== this.#owned);
    if (produced.length === 0) this.#checkOwned();
    state.emit({ type: 'stage.leaved', stageId: this.#id, facts: answer });
    this.#published = true;
    this.#answer.resolve(answer);
    await this.#settle(produced);
  }

  async #settle(produced: readonly AnyStream[]): Promise<void> {
    if (produced.length) await Promise.all(produced.map(stream => stream.done));
    if (this.#calls.size) await Promise.all([...this.#calls].map(call => call.result));
    if (this.#panic) return;
    this.#checkOwned();
    if (this.#calls.size) await Promise.all([...this.#calls].map(call => call.done));
    if (this.#panic) return;
    if (this.#pendingDeferred.size) throw new Error(`Stage "${this.definition.name}" has an unsettled deferred`);
    this.settleIfReady();
  }

  #remember(key: object, call: Call): void {
    const known = this.#keys.get(key);
    this.#keys.set(key, known && known !== call ? ambiguous : call);
  }

  #abort(key: object): void {
    const call = this.#keys.get(key);
    if (call === ambiguous) this.#fail(new Error('Cannot abort an ambiguous child answer'));
    if (!call) this.#fail(new Error('Cannot abort a child call from outside its stage'));
    call.abort();
  }

  #scope(open: () => boolean) {
    const active = (): void => {
      if (!open() || this.#settled) this.#fail(new Error(`Stage "${this.definition.name}" scope has settled`));
    };
    const checked = <T>(run: () => T): T => {
      active();
      try {
        return run();
      } catch (error) {
        return this.#fail(error);
      }
    };
    const through = this.definition.through;
    const into = this.definition.into;
    return Object.freeze({
      signal: this.branch.signal,
      services: this.state.services,
      log: this.#log,
      abort: (key: object) => { this.#abort(key); },
      deferred: <T>() => checked(() => this.#deferred<T>()),
      defer: (work: Promise<unknown>) => checked(() => { this.state.defer(work); }),
      createStream: <T, E>(iterate: Producer<T, E>) => checked(() => this.#createStream(iterate)),
      wrapStream: <T, E, U, F>(inner: ManagedStream<T, E>, transform: Wrapper<T, E, U, F>) =>
        checked(() => this.#wrapStream(inner, transform)),
      run: (pipeline: AnyPipeline, facts: Facts) => checked(() => {
        linkTargets(pipeline);
        const assembly = assemblyOf(pipeline);
        return this.#call(assembly, 0, facts, open, assembly);
      }),
      ...(through && {
        next: (facts: Facts) => checked(() => this.#call(this.assembly, this.position + 1, facts, open, undefined, through)),
      }),
      ...(into && {
        into: Object.freeze(Object.fromEntries([...into].map(([key, declaration]) => [
          key,
          (facts: Facts) => checked(() => {
            const assembly = assemblyOf(this.assembly.linked!.get(key)!);
            return this.#call(assembly, 0, facts, open, assembly, declaration);
          }),
        ]))),
      }),
    });
  }

  #call(
    assembly: Assembly,
    position: number,
    facts: Facts,
    open: () => boolean,
    boundary?: Assembly,
    declaration?: ParsedThrough,
  ): Promise<Facts> {
    const where = `Stage "${this.definition.name}" child request`;
    this.#latest = facts;
    checkFacts(facts, where);
    if (declaration) {
      requireKeys(this.initial, declaration.request.needs, where);
      checkHandoff(this.initial, facts, declaration.request, where);
    }
    const owned = new Set<AnyStream>();
    transferStreams(streamsIn(facts), this.#owned, owned);
    const branch = new SignalBranch(this.branch);
    const child = new StageRun(this.state, branch, assembly, position, facts, this.#owned, this.#id, boundary);
    transferStreams(owned, owned, child.#owned);
    const recordsResponse = declaration && this.#executeOpen;
    const callResult = (answer: Facts): void => {
      this.#remember(answer, call);
      if (open()) this.#latest = answer;
      if (declaration) {
        requireKeys(answer, declaration.response.needs, `Stage "${this.definition.name}" child response`);
        if (recordsResponse) this.#continuations.push({ facts: answer, declaration: declaration.response });
      }
    };
    const call = new Call(child, answer => {
      try {
        callResult(answer);
      } catch (error) {
        this.#fail(error);
      }
    });
    this.#remember(call.result, call);
    this.#calls.add(call);
    if (this.#executeOpen) this.#waitingForAnswers.push(call.result);
    void call.done.then(() => { this.#calls.delete(call); }, () => { this.#calls.delete(call); });
    return call.result;
  }

  #createStream<T, E>(iterate: (scope: never, active: () => boolean) => AsyncIterable<Result<T, E>>, inner?: AnyStream): ManagedStream<T, E> {
    let open = false;
    const resource = new StreamResource(this.#owned, () => {
      open = true;
      return iterate(this.#scope(() => open) as never, () => open);
    }, {
      emit: event => { this.state.emit(event); },
      panic: error => this.#fail(error),
      finishProducer: () => { open = false; },
    }, inner);
    this.#produced.add(resource);
    void resource.done.then(() => { this.#produced.delete(resource); }, () => { this.#produced.delete(resource); });
    return resource.handle;
  }

  #wrapStream<T, E, U, F>(inner: ManagedStream<T, E>, transform: Wrapper<T, E, U, F>): ManagedStream<U, F> {
    const resource = resourceOf(inner);
    if (!resource || resource.exhausted || !resource.canTransfer(this.#owned)) {
      throw new Error('Wrapper source is not owned by the wrapping stage');
    }
    let active = (): boolean => false;
    const source = resource.wrap(() => active(), error => this.#fail(error));
    return this.#createStream((scope, open) => {
      active = open;
      return transform(source, scope);
    }, resource);
  }

  #deferred<T>(): DeferredController<T> {
    const promise = Promise.withResolvers<T>();
    void promise.promise.catch(() => undefined);
    const deferred = registerHandle({ promise: promise.promise }) as Deferred<T>;
    const finish = (result: Result<T, unknown>): void => {
      if (!this.#pendingDeferred.delete(cancel)) this.#fail(new Error('Deferred has already settled'));
      if (result.ok) promise.resolve(result.value);
      else promise.reject(result.error);
      this.state.emit({ type: 'deferred.settled', deferred, ...result });
    };
    const cancel = (error: unknown): void => { finish({ ok: false, error }); };
    this.#pendingDeferred.add(cancel);
    return Object.freeze({
      deferred,
      resolve: (value: T) => { finish({ ok: true, value }); },
      reject: cancel,
    });
  }
}

export const run = <I, O, S>(pipeline: Pipeline<I, O, S>, facts: NoInfer<I>, options: RunOptions<NoInfer<S>>): RunHandle<O> => {
  linkTargets(pipeline);
  const state = new Runtime(options);
  const { signal } = options;
  const abort = (): void => { state.signal.abort(signal!.reason); };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });

  const assembly = assemblyOf(pipeline);
  const stage = new StageRun(state, state.signal, assembly, 0, facts as Facts, new Set(), undefined, assembly);
  const result = stage.result as Promise<O>;
  const settled = Promise.all([
    stage.result.then(async facts => { await Promise.all([...streamsIn(facts)].map(stream => stream.done)); }),
    stage.done,
  ]);
  const done = settled.then(async () => {
    signal?.removeEventListener('abort', abort);
    await state.finalize();
  }, async error => {
    signal?.removeEventListener('abort', abort);
    try {
      await state.finalize();
    } finally {
      throw error;
    }
  });
  void done.catch(() => undefined);
  return Object.freeze({ result, done });
};
