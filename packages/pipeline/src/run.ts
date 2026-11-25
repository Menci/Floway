import { Branch } from './cancellation.ts';
import { assemblyOf } from './compose.ts';
import type { AnyPipeline, Assembly, Pipeline } from './compose.ts';
import { Custody, resourceOf, resourcesIn } from './custody.ts';
import { checkHandoff, checkResponse, requireKeys } from './declarations.ts';
import type { ContinuationAnswer, ParsedThrough } from './declarations.ts';
import { DeferredResource } from './deferred.ts';
import type { Emit, IdOf, Observer, RunEvent } from './events.ts';
import { freezeFacts, isObject } from './facts.ts';
import { stageLogger } from './log.ts';
import { StreamResource } from './stream.ts';
import type { StreamGenerator } from './stream.ts';
import type { Deferred, Facts, Handle, ManagedStream, Read } from './values.ts';

interface RunOptions<S> {
  readonly services: S;
  readonly signal: AbortSignal;
  readonly events?: Observer;
  readonly waitUntil: (work: Promise<unknown>) => void;
}

interface RunHandle<O> {
  readonly result: Promise<O>;
  readonly done: Promise<void>;
  readonly read: Read;
  readonly discard: (handle: Handle) => void;
}

type StageOutcome = Extract<RunEvent, { type: 'stage.leaved' }>;
type Factory<T> = (scope: never) => T;

const read = (holder: Custody, handle: Handle) => {
  const resource = holder.resource(handle);
  if (resource instanceof StreamResource) return resource.read(holder);
  if (resource instanceof DeferredResource) return resource.read(holder);
  throw new TypeError('Expected a pipeline stream or deferred handle');
};

class Runtime {
  readonly services: object;
  readonly #resources = new WeakSet<object>();
  #stageId = 0;
  #streamId = 0;
  #deferredId = 0;

  constructor(readonly options: RunOptions<unknown>) {
    this.services = Object.freeze({ ...options.services as object });
  }

  stageId(): number { return ++this.#stageId; }

  stream(holder: Executor, producer: Executor): StreamResource {
    const stream = new StreamResource(
      ++this.#streamId, holder.custody, this.emit, producer.exit, work => { holder.stage.track(work); },
    );
    this.#resources.add(stream);
    holder.stage.track(stream.done);
    return stream;
  }

  deferred(holder: Executor, producer: Executor): DeferredResource {
    const deferred = new DeferredResource(++this.#deferredId, holder.custody, this.emit, producer.exit);
    this.#resources.add(deferred);
    holder.stage.track(deferred.done);
    return deferred;
  }

  readonly emit: Emit = event => {
    try {
      this.options.events?.(event, this.#idOf);
    } catch (error) {
      queueMicrotask(() => { throw error; });
    }
  };

  readonly #idOf: IdOf = value => {
    const resource = isObject(value) ? resourceOf(value) : undefined;
    if (!resource || !this.#resources.has(resource)) return undefined;
    return resource.kind === 'stream' ? { streamId: resource.id } : { deferredId: resource.id };
  };
}

class StageRun {
  readonly id: number;
  readonly workerScope;
  readonly #executor: Executor;
  readonly #continuations: ContinuationAnswer[] = [];
  #outcome: StageOutcome | undefined;
  #pending = 1;

  constructor(
    readonly runtime: Runtime,
    readonly branch: Branch,
    readonly assembly: Assembly,
    readonly position: number,
    readonly request: Facts,
    incoming: Custody,
  ) {
    this.id = runtime.stageId();
    const log = stageLogger(this.definition.name, this.id, runtime.options.events && runtime.emit);
    this.workerScope = Object.freeze({ log, services: runtime.services });
    this.#executor = new Executor(this, incoming, this.#continuations);
  }

  get definition() { return this.assembly.stages[this.position]; }

  track(work: Promise<unknown>): void {
    this.#pending += 1;
    const finished = (): void => { this.#settle(); };
    void work.then(finished, finished);
  }

  async execute(destination: Custody, parentStageId?: number): Promise<Facts> {
    const { branch, definition, request } = this;
    const where = `Stage "${definition.name}"`;
    try {
      this.runtime.emit({
        type: 'stage.entered',
        stageId: this.id,
        name: definition.name,
        ...(parentStageId === undefined ? {} : { parentStageId }),
        facts: request,
      });
      if (this.position === 0) requireKeys(request, this.assembly.entry, `${where} entry`);
      requireKeys(request, definition.requestNeeds, `${where} request`);
      const answer = freezeFacts(await definition.execute(request, this.#executor.scope() as never), `${where} response`);
      checkResponse(answer, definition.answer, this.#continuations, `${where} response`);
      if (this.position === 0) requireKeys(answer, this.assembly.exit, `${where} exit`);
      const resources = resourcesIn(answer);
      this.#executor.custody.transferAnswer(resources, destination, where);
      for (const resource of resources) {
        if (!resource.settled) branch.track(resource.done);
      }
      this.#outcome = { type: 'stage.leaved', stageId: this.id, facts: answer };
      return answer;
    } catch (error) {
      this.#outcome = { type: 'stage.leaved', stageId: this.id, error };
      throw error;
    } finally {
      this.#executor.exit(false);
      this.#continuations.length = 0;
      this.#settle();
    }
  }

  #settle(): void {
    this.#pending -= 1;
    if (this.#pending > 0) return;
    try {
      this.runtime.emit(this.#outcome!);
    } finally {
      this.branch.release();
    }
  }
}

class Executor {
  readonly #calls = new WeakMap<Promise<unknown>, Branch>();
  #active = true;

  constructor(
    readonly stage: StageRun,
    readonly custody = new Custody(),
    readonly continuationAnswers?: ContinuationAnswer[],
  ) {}

  scope() {
    const { assembly, branch, definition, position, workerScope } = this.stage;
    const { through, into } = definition;
    return Object.freeze({
      ...workerScope,
      signal: branch.signal,
      read: ((handle: Handle) => {
        this.#requireActive();
        return read(this.custody, handle);
      }) as Read,
      discard: (handle: Handle): void => {
        this.#requireActive();
        this.stage.track(this.custody.discard(this.custody.resource(handle)));
      },
      abort: (promise: Promise<unknown>): void => {
        this.#requireActive();
        const call = this.#calls.get(promise);
        if (!call) throw new Error('Can only abort the original promise of a child call from this executor');
        call.abort();
      },
      run: (pipeline: AnyPipeline, facts: Facts) => this.#call(assemblyOf(pipeline), 0, facts),
      ...(through && { next: (facts: Facts) => this.#call(assembly, position + 1, facts, through) }),
      ...(into && {
        into: Object.freeze(Object.fromEntries([...assembly.targets].map(([key, target]) => [
          key,
          (facts: Facts) => this.#call(target.assembly, 0, facts, target.declaration),
        ]))),
      }),
      createStream: (factory: Factory<StreamGenerator>) => this.#createStream(factory),
      wrapStream: (inner: ManagedStream<unknown, unknown>, factory: (inner: ManagedStream<unknown, unknown>, scope: never) => StreamGenerator) =>
        this.#createStream(scope => factory(inner, scope), inner),
      createDeferred: (factory: Factory<Promise<unknown>>) => this.#createDeferred(factory),
      wrapDeferred: (inner: Deferred<unknown>, factory: (inner: Deferred<unknown>, scope: never) => Promise<unknown>) =>
        this.#createDeferred(scope => factory(inner, scope), inner),
      detach: (worker: (scope: typeof workerScope) => Promise<unknown>): void => {
        this.#requireActive();
        this.stage.runtime.options.waitUntil(worker(workerScope));
      },
    });
  }

  readonly exit = (normal: boolean): void => {
    if (!this.#active) return;
    this.#active = false;
    const leaked = this.custody.size;
    this.#discardAll(this.custody);
    if (normal && leaked > 0) throw new Error(`Producer of stage "${this.stage.definition.name}" leaked ${leaked} stream or deferred handle(s)`);
  };

  #requireActive(): void {
    if (!this.#active) throw new Error(`Stage "${this.stage.definition.name}" executor has exited`);
  }

  #discardAll(holder: Custody): void {
    for (const drain of holder.discardAll()) this.stage.track(drain);
  }

  #call(assembly: Assembly, position: number, facts: Facts, continuation?: ParsedThrough): Promise<Facts> {
    this.#requireActive();
    const { stage } = this;
    const where = `Stage "${stage.definition.name}" child`;
    freezeFacts(facts, `${where} request`);
    if (continuation) {
      requireKeys(stage.request, continuation.request.needs, `${where} request`);
      checkHandoff(stage.request, facts, continuation.request, `${where} request`);
    }
    const incoming = new Custody();
    this.custody.transfer(resourcesIn(facts), incoming);
    const branch = new Branch(stage.branch);
    const returned = new Custody();
    const child = new StageRun(stage.runtime, branch, assembly, position, facts, incoming);
    stage.track(branch.done);
    const answer = child.execute(returned, stage.id).then(result => {
      if (!this.#active) {
        this.#discardAll(returned);
        return result;
      }
      try {
        if (continuation) {
          requireKeys(result, continuation.response.needs, `${where} response`);
          this.continuationAnswers?.push({ facts: result, declaration: continuation.response });
        }
        returned.transfer(resourcesIn(result), this.custody);
        return result;
      } catch (error) {
        this.#discardAll(returned);
        throw error;
      }
    });
    stage.track(answer);
    this.#calls.set(answer, branch);
    return answer;
  }

  #prepare<T>(factory: Factory<T>, kind: 'stream' | 'deferred', inner?: Handle): { producer: Executor; output: T } {
    this.#requireActive();
    const producer = new Executor(this.stage);
    if (inner) {
      const resource = this.custody.resource(inner);
      if (resource.kind !== kind) throw new TypeError(`Expected a pipeline ${kind} handle`);
      this.custody.transfer(new Set([resource]), producer.custody);
    }
    try {
      return { producer, output: factory(producer.scope() as never) };
    } catch (error) {
      producer.exit(false);
      throw error;
    }
  }

  #createStream(factory: Factory<StreamGenerator>, inner?: ManagedStream<unknown, unknown>): ManagedStream<unknown, unknown> {
    const { producer, output } = this.#prepare(factory, 'stream', inner);
    const stream = this.stage.runtime.stream(this, producer);
    stream.start(output);
    return stream.handle;
  }

  #createDeferred(factory: Factory<Promise<unknown>>, inner?: Deferred<unknown>): Deferred<unknown> {
    const { producer, output } = this.#prepare(factory, 'deferred', inner);
    const deferred = this.stage.runtime.deferred(this, producer);
    deferred.start(output);
    return deferred.handle;
  }
}

export const run = <I, O, S>(pipeline: Pipeline<I, O, S>, facts: NoInfer<I>, options: RunOptions<NoInfer<S>>): RunHandle<O> => {
  const assembly = assemblyOf(pipeline);
  const runtime = new Runtime(options);
  const { signal } = options;
  const branch = new Branch();
  const host = new Custody();
  const initial = freezeFacts(facts as Facts, `Pipeline "${pipeline.name}" entry`);
  const incoming = new Custody();
  host.transfer(resourcesIn(initial), incoming);
  const abort = (): void => { branch.abort(signal.reason); };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  void branch.done.then(() => { signal.removeEventListener('abort', abort); });

  const first = new StageRun(runtime, branch, assembly, 0, initial, incoming);
  const result = first.execute(host);
  const done = result.then(async answer => {
    await Promise.all([...resourcesIn(answer)].map(resource => Promise.race([resource.done, resource.discarded])));
  });
  void done.catch(() => undefined);
  return Object.freeze({
    result: result as Promise<O>,
    done,
    read: ((handle: Handle) => read(host, handle)) as Read,
    discard: (handle: Handle): void => { void host.discard(host.resource(handle)); },
  });
};
