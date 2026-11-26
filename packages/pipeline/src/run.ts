import { createLogg } from '@guiiai/logg';

import { Call } from './cancellation.ts';
import { entryAssembly } from './compose.ts';
import type { Assembly, Entry } from './compose.ts';
import { Custody, requireResource, resourceOf, resourcesIn } from './custody.ts';
import { checkExit, checkHandoff, checkResponse, requireKeys } from './declarations.ts';
import type { ContinuationAnswer, ParsedThrough } from './declarations.ts';
import { DeferredResource } from './deferred.ts';
import { freezeFacts } from './facts.ts';
import type { StageDefinition } from './stage.ts';
import { StreamResource } from './stream.ts';
import type { StreamGenerator } from './stream.ts';
import type { Deferred, Facts, Handle, ManagedStream, Read } from './values.ts';

interface RunOptions<S> {
  readonly services: S;
  readonly signal: AbortSignal;
  readonly waitUntil: (work: Promise<unknown>) => void;
}

interface RunHandle<O> {
  readonly result: Promise<O>;
  readonly read: Read;
  readonly discard: (answer: O) => void;
}

const read = (holder: Custody, handle: Handle) => {
  const resource = requireResource(handle);
  if (resource instanceof StreamResource) return resource.read(holder);
  if (resource instanceof DeferredResource) return resource.read(holder);
  throw new TypeError('Expected a pipeline stream or deferred handle');
};

interface StageRun {
  readonly services: object;
  readonly waitUntil: RunOptions<unknown>['waitUntil'];
  readonly call: Call;
  readonly assembly: Assembly;
  readonly position: number;
  readonly definition: StageDefinition;
  readonly request: Facts;
  readonly log: ReturnType<typeof createLogg>;
}

type Factory<T> = (scope: never) => T;

class Executor {
  readonly #calls = new WeakMap<Promise<unknown>, Call>();
  readonly #pending = new Set<Promise<Facts>>();
  readonly #answers: ContinuationAnswer[] = [];
  #active = true;

  constructor(readonly stage: StageRun, readonly custody = new Custody()) {}

  scope() {
    const { stage } = this;
    const workerScope = Object.freeze({ log: stage.log, services: stage.services });
    const scope = {
      ...workerScope,
      signal: stage.call.signal,
      read: (handle: Handle) => {
        this.#requireActive();
        return read(this.custody, handle);
      },
      discard: (value: Handle | Facts): void => {
        this.#requireActive();
        const resource = resourceOf(value);
        if (resource) this.custody.discard(resource, stage.waitUntil, stage.call);
        else this.custody.discardAnswer(value as Facts, stage.waitUntil, stage.call);
      },
      abort: (promise: Promise<unknown>): void => {
        this.#requireActive();
        const child = this.#calls.get(promise);
        if (!child) throw new TypeError('Expected the original promise of a child call from this scope');
        child.abort();
      },
      run: (entry: Parameters<typeof entryAssembly>[0], facts: Facts) => this.#call(entryAssembly(entry), 0, facts),
      createStream: (factory: Factory<StreamGenerator>) => this.#createStream(factory),
      wrapStream: (inner: ManagedStream<unknown, unknown>, factory: (inner: ManagedStream<unknown, unknown>, scope: never) => StreamGenerator) =>
        this.#createStream(scope => factory(inner, scope), inner),
      createDeferred: (factory: Factory<Promise<unknown>>) => this.#createDeferred(factory),
      wrapDeferred: (inner: Deferred<unknown>, factory: (inner: Deferred<unknown>, scope: never) => Promise<unknown>) =>
        this.#createDeferred(scope => factory(inner, scope), inner),
      detach: (worker: (scope: typeof workerScope) => Promise<unknown>): void => {
        this.#requireActive();
        let work: Promise<unknown>;
        try {
          work = worker(workerScope);
        } catch (error) {
          work = Promise.reject(error);
        }
        stage.waitUntil(work);
      },
    };
    const { through, into } = stage.definition;
    return Object.freeze({
      ...scope,
      ...(through && { next: (facts: Facts) => this.#call(stage.assembly, stage.position + 1, facts, through) }),
      ...(into && {
        into: Object.freeze(Object.fromEntries([...stage.assembly.targets].map(([key, target]) =>
          [key, (facts: Facts) => this.#call(target.assembly, 0, facts, target.declaration)]))),
      }),
    });
  }

  answer(facts: Facts, holder: Custody): void {
    this.#close();
    const where = `Stage "${this.stage.definition.name}" response`;
    freezeFacts(facts, where);
    checkResponse(facts, this.stage.definition.answer, this.#answers, where);
    if (this.stage.position === 0) checkExit(facts, this.stage.assembly.exit, `Pipeline "${this.stage.assembly.name}" exit`);
    const resources = resourcesIn(facts);
    this.#checkLeaks(resources.size);
    this.custody.transfer(resources, holder);
    holder.receive(facts);
  }

  exit = (normal: boolean): void => {
    this.#close();
    const outstanding = this.custody.size;
    this.custody.discardHeld(this.stage.waitUntil, this.stage.call);
    if (normal && outstanding > 0) this.#leak(outstanding);
  };

  #requireActive(): void {
    if (!this.#active) throw new Error(`Stage "${this.stage.definition.name}" scope has exited`);
  }

  #close(): void {
    if (!this.#active) return;
    this.#active = false;
    for (const pending of this.#pending) {
      // An exiting executor relinquishes the dependency. Keep the delivery alive for orphan cleanup.
      this.stage.waitUntil(pending.then(() => undefined, () => undefined));
    }
  }

  #checkLeaks(transferring: number): void {
    const outstanding = this.custody.size - transferring;
    if (outstanding > 0) this.#leak(outstanding);
  }

  #leak(outstanding: number): never {
    throw new Error(`Stage "${this.stage.definition.name}" leaked ${outstanding} stream or deferred handle(s)`);
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
    const inputResources = resourcesIn(facts);
    this.custody.transfer(inputResources, incoming);
    const child = new Call(stage.call.signal, stage.call.retain());
    const returned = new Custody();
    const answer = execute({ ...stage, call: child, assembly, position, request: facts }, incoming, returned).then(result => {
      if (!this.#active) {
        returned.discardHeld(stage.waitUntil, stage.call);
        return result;
      }
      try {
        if (continuation) requireKeys(result, continuation.response.needs, `${where} response`);
        const outputResources = resourcesIn(result);
        returned.transfer(outputResources, this.custody);
        if (inputResources.size > 0) {
          for (const resource of outputResources) {
            if (inputResources.has(resource)) resource.retainCall(child);
          }
        }
        this.custody.receive(result);
        if (continuation) this.#answers.push({ facts: result, declaration: continuation.response });
        return result;
      } catch (error) {
        returned.discardHeld(stage.waitUntil, stage.call);
        throw error;
      }
    });
    this.#pending.add(answer);
    this.#calls.set(answer, child);
    const settled = (): void => {
      this.#pending.delete(answer);
      child.release();
    };
    void answer.then(settled, settled);
    return answer;
  }

  #prepare<T>(factory: Factory<T>, inner?: Handle): { producer: Executor; output: T } {
    this.#requireActive();
    const producer = new Executor(this.stage);
    if (inner) this.custody.transfer(new Set([requireResource(inner)]), producer.custody);
    try {
      return { producer, output: factory(producer.scope() as never) };
    } catch (error) {
      producer.exit(false);
      throw error;
    }
  }

  #createStream(factory: Factory<StreamGenerator>, inner?: ManagedStream<unknown, unknown>): ManagedStream<unknown, unknown> {
    const { producer, output } = this.#prepare(factory, inner);
    return new StreamResource(this.custody, {
      generator: output,
      exit: producer.exit,
      finish: this.stage.call.retain(),
      waitUntil: this.stage.waitUntil,
    }).handle;
  }

  #createDeferred(factory: Factory<Promise<unknown>>, inner?: Deferred<unknown>): Deferred<unknown> {
    const { producer, output } = this.#prepare(factory, inner);
    return new DeferredResource(this.custody, output, producer.exit, this.stage.call.retain()).handle;
  }
}

const execute = async (stage: Omit<StageRun, 'definition' | 'log'>, incoming: Custody, holder: Custody): Promise<Facts> => {
  const definition = stage.assembly.stages[stage.position]!;
  const log = createLogg(definition.name).useGlobalConfig();
  const executor = new Executor({ ...stage, definition, log }, incoming);
  try {
    if (stage.position === 0) requireKeys(stage.request, stage.assembly.entry, `Pipeline "${stage.assembly.name}" entry`);
    requireKeys(stage.request, definition.requestNeeds, `Stage "${definition.name}" request`);
    const result = await definition.execute(stage.request, executor.scope() as never);
    executor.answer(result, holder);
    return result;
  } catch (error) {
    executor.exit(false);
    throw error;
  }
};

export const run = <I, O, S extends object>(entry: Entry<I, O, S>, facts: NoInfer<I>, options: RunOptions<NoInfer<S>>): RunHandle<O> => {
  const assembly = entryAssembly(entry);
  const host = new Custody();
  const incoming = new Custody();
  const request = freezeFacts(facts as Facts, `Pipeline "${assembly.name}" entry`);
  host.transfer(resourcesIn(request), incoming);
  const call = new Call(options.signal);
  const result = execute({
    assembly,
    position: 0,
    request,
    services: options.services,
    waitUntil: options.waitUntil,
    call,
  }, incoming, host).finally(() => { call.release(); });
  return Object.freeze({
    result: result as Promise<O>,
    read: ((handle: Handle) => read(host, handle)) as Read,
    discard: (answer: O): void => { host.discardAnswer(answer as Facts, options.waitUntil); },
  });
};
