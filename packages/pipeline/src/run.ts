import { createLogg } from '@guiiai/logg';

import { Call } from './cancellation.ts';
import { entryAssembly } from './compose.ts';
import type { Assembly, Entry } from './compose.ts';
import { Custody, requireResource, resourceOf, resourcesIn } from './custody.ts';
import type { Resource } from './custody.ts';
import { checkEntry, checkExit, checkHandoff, checkInPlace, requireKeys } from './declarations.ts';
import type { ParsedSide, ParsedThrough } from './declarations.ts';
import { DeferredResource } from './deferred.ts';
import { freezeFacts, isObject } from './facts.ts';
import type {
  AbortHandle,
  HostScopeOptions,
  RootHostScope,
  RunCallOptions,
  StageDefinition,
} from './stage.ts';
import { StreamResource } from './stream.ts';
import type { StreamGenerator } from './stream.ts';
import type { Deferred, Facts, Handle, ManagedStream, Read } from './values.ts';

type CallKind = 'continuation' | 'run';

interface CallRecord {
  readonly kind: CallKind;
  readonly call: Call;
  readonly declaration: ParsedSide | undefined;
  state: 'pending' | 'fulfilled' | 'rejected';
  discarded: boolean;
  outcome: Promise<Facts>;
  facts: Facts | undefined;
  answerResources: Set<Resource> | undefined;
}

interface StageRun {
  readonly services: object;
  readonly waitUntil: (work: Promise<unknown>) => void;
  readonly call: Call;
  readonly assembly: Assembly;
  readonly position: number;
  readonly isRootRun: boolean;
  readonly definition: StageDefinition;
  readonly request: Facts;
  readonly log: ReturnType<typeof createLogg>;
}

const requireRunServices = (options: RunCallOptions<object> | undefined): object => {
  if (!options || typeof options !== 'object' || !('services' in options) || !isObject(options.services)) {
    throw new TypeError('Expected explicit { services } for pipeline run');
  }
  return options.services;
};

class CallOwner {
  readonly #callsByPromise = new WeakMap<Promise<unknown>, CallRecord>();
  readonly #activeCalls = new Set<CallRecord>();
  #active = true;

  constructor(
    readonly label: string,
    readonly parentSignal: AbortSignal,
    readonly waitUntil: (work: Promise<unknown>) => void,
    readonly custody: Custody,
    readonly ownerCall?: Call,
  ) {}

  get active(): boolean { return this.#active; }
  get activeCalls(): ReadonlySet<CallRecord> { return this.#activeCalls; }

  requireActive(): void {
    if (!this.#active) throw new Error(`${this.label} has exited`);
  }

  read = ((handle: Handle) => {
    this.requireActive();
    const resource = requireResource(handle);
    if (resource instanceof StreamResource) {
      return resource.read(this.custody, () => {
        this.requireActive();
        if (resource.heldBy(this.custody)) this.custody.discard(resource, this.waitUntil, this.ownerCall);
      });
    }
    if (resource instanceof DeferredResource) return resource.read(this.custody);
    throw new TypeError('Expected a pipeline stream or deferred handle');
  }) as Read;

  abort = (promise: Promise<unknown>, reason?: unknown): AbortHandle => {
    this.requireActive();
    const record = isObject(promise) ? this.#callsByPromise.get(promise) : undefined;
    if (!record) throw new TypeError('Expected the original promise of a child call from this scope');
    record.call.abort(reason);
    return Object.freeze({
      discard: (): void => { this.#discardCall(record); },
    });
  };

  discard = (target: Handle | Promise<unknown>): void => {
    this.requireActive();
    if (isObject(target)) {
      const resource = resourceOf(target);
      if (resource) {
        this.custody.discardHandle(resource, this.waitUntil, this.ownerCall);
        return;
      }
      const record = this.#callsByPromise.get(target as Promise<unknown>);
      if (record) {
        this.#discardCall(record);
        return;
      }
    }
    throw new TypeError('Expected a pipeline handle or the original promise of a child call from this scope');
  };

  startRun = <I, O, RS extends object>(
    entry: Entry<I, O, RS>,
    facts: NoInfer<I>,
    options: RunCallOptions<NoInfer<RS>>,
  ): Promise<O> => {
    this.requireActive();
    const services = requireRunServices(options);
    const assembly = entryAssembly(entry);
    return this.startCall(assembly, 0, facts as Facts, services, 'run') as Promise<O>;
  };

  startCall(
    assembly: Assembly,
    position: number,
    facts: Facts,
    services: object,
    kind: CallKind,
    continuation?: ParsedThrough,
    stageRequest?: Facts,
  ): Promise<Facts> {
    this.requireActive();
    const where = kind === 'run' ? `Pipeline "${assembly.name}" entry` : `${this.label} child`;
    freezeFacts(facts, kind === 'run' ? where : `${where} request`);
    if (continuation) {
      requireKeys(stageRequest!, continuation.request.needs, `${where} request`);
      checkHandoff(stageRequest!, facts, continuation.request, `${where} request`);
    }
    const incoming = new Custody();
    const inputResources = resourcesIn(facts);
    this.custody.transfer(inputResources, incoming);
    const child = new Call(this.parentSignal, this.ownerCall?.retain());
    const returned = new Custody();
    const record: CallRecord = {
      kind,
      call: child,
      declaration: continuation?.response,
      state: 'pending',
      discarded: false,
      outcome: undefined as unknown as Promise<Facts>,
      facts: undefined,
      answerResources: undefined,
    };
    const outcome = execute({
      services,
      waitUntil: this.waitUntil,
      call: child,
      assembly,
      position,
      isRootRun: kind === 'run',
      request: facts,
    }, incoming, returned).then(result => {
      record.state = 'fulfilled';
      try {
        if (record.discarded || !this.#active) {
          returned.discardHeld(this.waitUntil, this.ownerCall);
          return result;
        }
        if (continuation) requireKeys(result, continuation.response.needs, `${where} response`);
        const outputResources = resourcesIn(result);
        returned.transfer(outputResources, this.custody);
        if (inputResources.size > 0) {
          for (const resource of outputResources) {
            if (inputResources.has(resource)) resource.retainCall(child);
          }
        }
        record.facts = result;
        record.answerResources = outputResources;
        return result;
      } catch (error) {
        returned.discardHeld(this.waitUntil, this.ownerCall);
        record.state = 'rejected';
        this.#activeCalls.delete(record);
        throw error;
      } finally {
        child.release();
      }
    }, (error: unknown) => {
      record.state = 'rejected';
      this.#activeCalls.delete(record);
      child.release();
      throw error;
    });
    record.outcome = outcome;
    this.#activeCalls.add(record);
    this.#callsByPromise.set(outcome, record);
    return outcome;
  }

  close(): number {
    if (!this.#active) return 0;
    this.#active = false;
    const undiscardedCount = this.#activeCalls.size;
    for (const record of this.#activeCalls) {
      if (record.state === 'pending' && !record.discarded) {
        record.discarded = true;
        this.waitUntil(record.outcome.then(() => undefined));
      }
      record.facts = undefined;
      record.answerResources = undefined;
    }
    this.#activeCalls.clear();
    return undiscardedCount;
  }

  #discardCall(record: CallRecord): void {
    this.requireActive();
    if (record.discarded) return;
    record.discarded = true;
    this.#activeCalls.delete(record);
    if (record.state === 'pending') {
      this.waitUntil(record.outcome.then(() => undefined));
      return;
    }
    if (record.state === 'fulfilled') {
      const resources = record.answerResources;
      record.facts = undefined;
      record.answerResources = undefined;
      if (resources) this.custody.discardResources(resources, this.waitUntil, this.ownerCall);
    }
  }
}

type Factory<T> = (scope: never) => T;

class Executor {
  readonly #owner: CallOwner;

  constructor(readonly stage: StageRun, readonly custody = new Custody()) {
    this.#owner = new CallOwner(
      `Stage "${stage.definition.name}" scope`,
      stage.call.signal,
      stage.waitUntil,
      custody,
      stage.call,
    );
  }

  scope() {
    const { stage } = this;
    const workerScope = Object.freeze({ log: stage.log, services: stage.services });
    const base = {
      ...workerScope,
      signal: stage.call.signal,
      read: this.#owner.read,
      discard: this.#owner.discard,
      abort: this.#owner.abort,
      run: this.#owner.startRun,
      createStream: (factory: Factory<StreamGenerator>) => this.#createStream(factory),
      wrapStream: (inner: ManagedStream<unknown, unknown>, factory: (inner: ManagedStream<unknown, unknown>, scope: never) => StreamGenerator) => {
        this.#owner.requireActive();
        const resource = requireResource(inner);
        if (!(resource instanceof StreamResource)) throw new TypeError('Expected a pipeline stream handle');
        return this.#createStream(scope => factory(inner, scope), resource);
      },
      createDeferred: (factory: Factory<Promise<unknown>>) => this.#createDeferred(factory),
      wrapDeferred: (inner: Deferred<unknown>, factory: (inner: Deferred<unknown>, scope: never) => Promise<unknown>) => {
        this.#owner.requireActive();
        const resource = requireResource(inner);
        if (!(resource instanceof DeferredResource)) throw new TypeError('Expected a pipeline deferred handle');
        return this.#createDeferred(scope => factory(inner, scope), resource);
      },
      detach: (worker: (scope: typeof workerScope) => Promise<unknown>): void => {
        this.#owner.requireActive();
        let work: unknown;
        try {
          work = worker(workerScope);
        } catch (error) {
          stage.waitUntil(Promise.reject(error));
          return;
        }
        if (typeof work !== 'object' || work === null || typeof (work as { then?: unknown }).then !== 'function') {
          throw new TypeError('A pipeline detach worker must return a Promise');
        }
        stage.waitUntil(work as Promise<unknown>);
      },
    };
    const { through, into } = stage.definition;
    let intoTargets: Readonly<Record<string, (facts: Facts) => Promise<Facts>>> | undefined;
    if (into) {
      const map = Object.create(null) as Record<string, (facts: Facts) => Promise<Facts>>;
      for (const [key, target] of stage.assembly.targets) {
        map[key] = (facts: Facts) => this.#owner.startCall(
          target.assembly,
          0,
          facts,
          stage.services,
          'continuation',
          target.declaration,
          stage.request,
        );
      }
      intoTargets = Object.freeze(map);
    }
    return Object.freeze({
      ...base,
      ...(through && {
        next: (facts: Facts) => this.#owner.startCall(
          stage.assembly,
          stage.position + 1,
          facts,
          stage.services,
          'continuation',
          through,
          stage.request,
        ),
      }),
      ...(intoTargets && { into: intoTargets }),
    });
  }

  answer(facts: Facts, holder: Custody): void {
    const where = `Stage "${this.stage.definition.name}" response`;
    freezeFacts(facts, where);

    let pendingCount = 0;
    let runCount = 0;
    const continuations: CallRecord[] = [];
    for (const record of this.#owner.activeCalls) {
      if (record.state === 'pending') pendingCount += 1;
      else if (record.kind === 'run') runCount += 1;
      else if (record.state === 'fulfilled') continuations.push(record);
    }
    if (pendingCount > 0) {
      throw new Error(`Stage "${this.stage.definition.name}" returned with ${pendingCount} undiscarded pending child call(s)`);
    }
    if (runCount > 0) {
      throw new Error(`Stage "${this.stage.definition.name}" returned with ${runCount} undiscarded sub-request run(s)`);
    }
    if (continuations.length > 1) {
      throw new Error(`Stage "${this.stage.definition.name}" returned with ${continuations.length} undiscarded continuation(s)`);
    }
    if (continuations.length === 1) {
      const [sole] = continuations;
      checkHandoff(sole!.facts!, facts, sole!.declaration!, where);
    } else {
      if (!this.stage.definition.answer) {
        throw new TypeError(`${where} does not match an in-place return or an answered continuation`);
      }
      checkInPlace(facts, this.stage.definition.answer, where);
    }
    if (this.stage.position === 0) {
      checkExit(facts, this.stage.assembly.exit, `Pipeline "${this.stage.assembly.name}" exit`);
    }

    const resources = resourcesIn(facts);
    this.custody.checkTransfer(resources);
    const leaked = this.custody.unfulfilledCount(resources);
    if (leaked > 0) this.#leakHandles(leaked);

    this.#owner.close();
    this.custody.drainAutoDrainable(this.stage.waitUntil, this.stage.call, resources);
    this.custody.transfer(resources, holder);
  }

  exit = (normal: boolean): void => {
    const undiscardedCalls = this.#owner.close();
    if (normal) {
      this.custody.drainAutoDrainable(this.stage.waitUntil, this.stage.call);
      const leakedHandles = this.custody.size;
      this.custody.discardHeld(this.stage.waitUntil, this.stage.call);
      if (undiscardedCalls > 0) {
        throw new Error(`Stage "${this.stage.definition.name}" producer exited with ${undiscardedCalls} undiscarded child call(s)`);
      }
      if (leakedHandles > 0) this.#leakHandles(leakedHandles);
      return;
    }
    this.custody.discardHeld(this.stage.waitUntil, this.stage.call);
  };

  #leakHandles(outstanding: number): never {
    throw new Error(`Stage "${this.stage.definition.name}" leaked ${outstanding} stream or deferred handle(s)`);
  }

  #prepare<T>(factory: Factory<T>, inner?: Resource): { producer: Executor; output: T } {
    this.#owner.requireActive();
    const producer = new Executor(this.stage);
    if (inner) this.custody.transfer(new Set([inner]), producer.custody);
    try {
      return { producer, output: factory(producer.scope() as never) };
    } catch (error) {
      producer.exit(false);
      throw error;
    }
  }

  #createStream(factory: Factory<StreamGenerator>, inner?: Resource): ManagedStream<unknown, unknown> {
    const { producer, output } = this.#prepare(factory, inner);
    const finish = this.stage.call.retain();
    try {
      return new StreamResource(this.custody, {
        generator: output,
        exit: producer.exit,
        finish,
      }).handle;
    } catch (error) {
      producer.exit(false);
      finish();
      throw error;
    }
  }

  #createDeferred(factory: Factory<Promise<unknown>>, inner?: Resource): Deferred<unknown> {
    const { producer, output } = this.#prepare(factory, inner);
    const finish = this.stage.call.retain();
    try {
      return new DeferredResource(this.custody, output, producer.exit, finish).handle;
    } catch (error) {
      producer.exit(false);
      finish();
      throw error;
    }
  }
}

const execute = async (stage: Omit<StageRun, 'definition' | 'log'>, incoming: Custody, holder: Custody): Promise<Facts> => {
  const definition = stage.assembly.stages[stage.position]!;
  const log = createLogg(definition.name).useGlobalConfig();
  const executor = new Executor({ ...stage, definition, log }, incoming);
  try {
    if (stage.position === 0) {
      const where = `Pipeline "${stage.assembly.name}" entry`;
      if (stage.isRootRun) checkEntry(stage.request, stage.assembly.entry, where);
      else requireKeys(stage.request, stage.assembly.entry, where);
    }
    requireKeys(stage.request, definition.requestNeeds, `Stage "${definition.name}" request`);
    const result = await definition.execute(stage.request, executor.scope() as never);
    executor.answer(result, holder);
    return result;
  } catch (error) {
    executor.exit(false);
    throw error;
  }
};

export const createHostScope = (options: HostScopeOptions): RootHostScope => {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createHostScope requires { signal, waitUntil }');
  }
  if (!(options.signal instanceof AbortSignal)) {
    throw new TypeError('createHostScope requires an AbortSignal');
  }
  if (typeof options.waitUntil !== 'function') {
    throw new TypeError('createHostScope requires a waitUntil function');
  }
  const custody = new Custody();
  const owner = new CallOwner('HostScope', options.signal, options.waitUntil, custody);
  return Object.freeze({
    signal: options.signal,
    read: owner.read,
    discard: owner.discard,
    abort: owner.abort,
    run: owner.startRun,
    close(): void {
      if (!owner.active) return;
      const undiscardedRuns = owner.close();
      custody.drainAutoDrainable(options.waitUntil);
      const leakedHandles = custody.size;
      custody.discardHeld(options.waitUntil);
      if (undiscardedRuns > 0 || leakedHandles > 0) {
        const parts: string[] = [];
        if (undiscardedRuns > 0) parts.push(`${undiscardedRuns} undiscarded run(s)`);
        if (leakedHandles > 0) parts.push(`${leakedHandles} leaked handle(s)`);
        throw new Error(`HostScope closed with ${parts.join(' and ')}`);
      }
    },
  });
};
