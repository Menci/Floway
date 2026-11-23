import type { OwnerDeferredFailure } from './deferred.ts';
import { ConcurrentStreamReadError, DuplicateStreamCloseError, StreamLeakError, StreamOwnershipError } from './errors.ts';
import { freezeData } from './facts.ts';
import { managedStreams } from './handles.ts';
import type { ManagedStream } from './handles.ts';

export type StreamEnd = { readonly how: 'exhausted' | 'released' | 'leaked' }
  | { readonly how: 'cancelled'; readonly reason: unknown }
  | { readonly how: 'errored'; readonly error: unknown };

export interface ReleasingInner<T> extends AsyncIterableIterator<T, undefined> {
  close(): Promise<void>;
}

export interface CreateStreamOptions<T> {
  readonly label: string;
  readonly iterate: (signal: AbortSignal) => AsyncIterable<T>;
  readonly onClose?: (end: StreamEnd) => void | Promise<void>;
}

export interface WrapStreamOptions<In, Out> {
  readonly label: string;
  readonly transform: (source: AsyncIterable<In>, signal: AbortSignal) => AsyncIterable<Out>;
  readonly onClose?: (end: StreamEnd, inner: ReleasingInner<In> | null) => void | Promise<void>;
}

export interface WrapStreamsOptions<Ins extends Record<string, unknown>, Out> {
  readonly label: string;
  readonly transform: (sources: { readonly [K in keyof Ins]: AsyncIterable<Ins[K]> }, signal: AbortSignal) => AsyncIterable<Out>;
  readonly onClose?: (end: StreamEnd, inners: { readonly [K in keyof Ins]: ReleasingInner<Ins[K]> | null }) => void | Promise<void>;
}

type Done = { readonly done: true; readonly value: undefined };
const done: Done = Object.freeze({ done: true, value: undefined });
const aborted = Symbol('aborted read');

const raceAbort = async <T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof aborted> => {
  if (signal.aborted) return aborted;
  const cancelled = Promise.withResolvers<typeof aborted>();
  const onAbort = (): void => cancelled.resolve(aborted);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([work, cancelled.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

export class Custody {
  readonly streams = new Set<StreamResource<unknown>>();

  constructor(readonly stageName: string, readonly signal: AbortSignal, readonly stopReading?: AbortSignal) {}

  async cleanup(): Promise<void> {
    const streams = [...this.streams];
    const leaked = streams.filter(stream => !stream.ending && !stream.interruptedRead);
    await Promise.allSettled(streams.map(stream => stream.stop({ how: stream.interruptedRead ? 'released' : 'leaked' })));
    if (leaked.length) throw new StreamLeakError(this.stageName, leaked.map(stream => stream.handle.label));
  }
}

export interface StreamFailure {
  readonly reason: unknown;
}

export interface StreamHooks {
  readonly membership: object;
  readonly id: number;
  readonly pull: (stream: StreamResource<unknown>) => (() => void) | undefined;
  readonly seal: (stream: StreamResource<unknown>, end: StreamEnd) => void;
  readonly finish: (stream: StreamResource<unknown>) => void | Promise<void>;
  readonly frame: (value: unknown) => void;
  readonly end: (end: StreamEnd, diagnostic: StreamFailure | undefined, failure: StreamFailure | undefined) => void;
}

export const combineErrors = (errors: readonly unknown[], message: string): unknown => {
  const unique = [...new Set(errors)];
  return unique.length === 1 ? unique[0] : new AggregateError(unique, message);
};

const streamFailure = (errors: readonly unknown[]): StreamFailure | undefined =>
  errors.length ? { reason: combineErrors(errors, 'Stream failed') } : undefined;

type Source<T> = AsyncIterator<T, unknown, void>;
type Pull<T> = IteratorResult<T, undefined>;
const resources = new WeakMap<ManagedStream<unknown>, StreamResource<unknown>>();

export const resourceOf = <T>(stream: ManagedStream<T>): StreamResource<T> => {
  const resource = resources.get(stream);
  if (!resource) throw new StreamOwnershipError(stream.label, 'stream lookup');
  return resource as StreamResource<T>;
};

export const streamIdOf = (stream: ManagedStream<unknown>): number => resourceOf(stream).id;

export class StreamResource<T> {
  readonly handle: ManagedStream<T>;
  readonly ended: Promise<void>;
  readonly completion: Promise<void>;
  readonly #ended = Promise.withResolvers<void>();
  readonly #completed = Promise.withResolvers<void>();
  readonly #controller = new AbortController();
  readonly #birthSignal: AbortSignal;
  readonly #onAbort: () => void;
  readonly #hooks: StreamHooks;
  readonly #iterate: (signal: AbortSignal) => AsyncIterable<T>;
  readonly #onClose: CreateStreamOptions<T>['onClose'];
  readonly #inners: readonly StreamResource<unknown>[];
  readonly #ownerEnded = new Set<() => OwnerDeferredFailure | undefined>();
  #owner: Custody | undefined;
  #source: Source<T> | undefined;
  #read: Promise<IteratorResult<T, unknown>> | undefined;
  #reading = false;
  #consuming = false;
  #interruptedRead = false;
  #wrapped = false;
  #releaseOwnsReads = false;
  #end: StreamEnd | undefined;
  #finished = false;

  constructor(owner: Custody, hooks: StreamHooks, options: CreateStreamOptions<T>, inners: readonly StreamResource<unknown>[] = []) {
    this.#hooks = hooks;
    this.#iterate = options.iterate;
    this.#onClose = options.onClose;
    this.#inners = inners;
    this.#birthSignal = owner.signal;
    this.#onAbort = () => {
      const { reason } = this.#birthSignal.aborted ? this.#birthSignal : this.#owner!.signal;
      void this.stop({ how: 'cancelled', reason });
    };
    this.ended = this.#ended.promise;
    this.completion = this.#completed.promise;
    void this.completion.catch(() => undefined);
    this.handle = Object.freeze({
      label: options.label,
      [Symbol.asyncIterator]: () => this.#open(),
      close: () => this.#closePublic(),
    });
    managedStreams.set(this.handle, hooks.membership);
    resources.set(this.handle, this);
    this.#birthSignal.addEventListener('abort', this.#onAbort, { once: true });
    this.move(owner);
  }

  get id(): number { return this.#hooks.id; }
  get ending(): boolean { return this.#end !== undefined; }
  get finished(): boolean { return this.#finished; }
  get interruptedRead(): boolean { return this.#interruptedRead; }

  assertOwned(owner: Custody, operation: string): void {
    if (this.#owner !== owner || this.#consuming || this.ending) throw new StreamOwnershipError(this.handle.label, operation);
  }

  move(owner: Custody | undefined): void {
    const signal = this.#owner?.signal;
    if (signal !== this.#birthSignal) signal?.removeEventListener('abort', this.#onAbort);
    this.#owner?.streams.delete(this);
    this.#owner = owner;
    if (owner) {
      owner.streams.add(this);
      if (owner.signal !== this.#birthSignal) owner.signal.addEventListener('abort', this.#onAbort, { once: true });
      if (owner.signal.aborted || this.#birthSignal.aborted) this.#onAbort();
    }
  }

  adopt(): void {
    this.#wrapped = true;
    this.move(undefined);
  }

  bindDeferred(onEnd: () => OwnerDeferredFailure | undefined): void {
    this.#ownerEnded.add(onEnd);
  }

  handOffReadFailures(): void {
    if (this.#releaseOwnsReads) return;
    if (!this.ending) this.#releaseOwnsReads = true;
    for (const inner of this.#inners) inner.handOffReadFailures();
  }

  #assertPublic(operation: string): void {
    if (this.#wrapped) throw new StreamOwnershipError(this.handle.label, operation);
  }

  #open(): AsyncIterator<T, undefined> {
    this.#assertPublic('iteration');
    if (this.#consuming) throw new DuplicateStreamCloseError(this.handle.label);
    if (this.#end?.how === 'cancelled') {
      this.#consuming = true;
      return { next: async () => done };
    }
    if (this.ending) throw new DuplicateStreamCloseError(this.handle.label);
    this.#consuming = true;
    const stopReading = this.#owner?.stopReading;
    return {
      next: () => stopReading ? this.#pullForProducer(stopReading) : this.pull(),
      return: async () => {
        if (!this.#finished) await this.stop({ how: 'released' });
        return done;
      },
    };
  }

  async #pullForProducer(signal: AbortSignal): Promise<Pull<T>> {
    const read = this.pull();
    const result = await raceAbort(read, signal);
    if (result !== aborted) return result;
    // The consumer has stopped. Its producer still owns the child's cleanup,
    // which runs after the producer's iterator and release hook finish.
    this.#interruptedRead = true;
    void read.catch(() => undefined);
    return done;
  }

  async #closePublic(): Promise<void> {
    this.#assertPublic('close()');
    if (this.ending) throw new DuplicateStreamCloseError(this.handle.label);
    await this.stop({ how: 'released' });
  }

  async pull(): Promise<Pull<T>> {
    if (this.#reading) throw new ConcurrentStreamReadError(this.handle.label);
    if (this.ending) return done;
    this.#reading = true;
    const leavePull = this.#hooks.pull(this);
    try {
      this.#read = Promise.resolve().then(() => {
        if (this.ending) return done;
        this.#source ??= this.#iterate(this.#controller.signal)[Symbol.asyncIterator]();
        return this.#source.next();
      });
      const result = await raceAbort(this.#read, this.#controller.signal);
      if (result === aborted || this.ending) return done;
      if (result.done) {
        this.#source = undefined;
        await this.stop({ how: 'exhausted' });
        return done;
      }
      const value = freezeData(result.value, `stream(${this.handle.label}).frame`);
      this.#hooks.frame(value);
      return { value, done: false };
    } catch (error) {
      if (this.ending && this.#end?.how !== 'exhausted') return done;
      await Promise.allSettled([this.stop({ how: 'errored', error })]);
      throw error;
    } finally {
      leavePull?.();
      if (!this.ending) this.#read = undefined;
      this.#reading = false;
    }
  }

  stop(end: StreamEnd): Promise<void> {
    if (this.#finished) return this.completion;
    if (this.#end) {
      if (end.how === 'cancelled' && this.#end.how !== 'cancelled') {
        this.#end = end;
        this.#hooks.seal(this, end);
        for (const inner of this.#inners) void inner.stop(end);
      }
      return this.completion;
    }
    this.#end = end;
    if (end.how === 'released') {
      for (const inner of this.#inners) inner.handOffReadFailures();
    }
    this.#ended.resolve();
    this.#hooks.seal(this, end);
    this.#controller.abort(end.how === 'cancelled' ? end.reason : end.how === 'errored' ? end.error : undefined);
    if (end.how === 'cancelled') {
      for (const inner of this.#inners) void inner.stop(end);
    }
    void Promise.resolve().then(() => this.#finalize()).then(this.#completed.resolve, this.#completed.reject);
    return this.completion;
  }

  async #finalize(): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (operation: () => unknown): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    if (this.#read) await Promise.allSettled([this.#read]);
    await attempt(() => this.#source?.return?.());
    this.#read = undefined;
    this.#source = undefined;
    await attempt(() => this.#onClose?.(this.#end!));
    for (const inner of this.#inners) {
      if (!inner.finished) await attempt(() => inner.stop({ how: 'released' }));
    }
    await attempt(() => this.#hooks.finish(this));
    const end = this.#end!;
    const cleanupErrors = [...errors];
    for (const ownerEnded of this.#ownerEnded) {
      const failure = ownerEnded();
      if (failure) cleanupErrors.push(failure.error);
    }
    this.#ownerEnded.clear();
    const diagnostic = streamFailure(end.how === 'errored' ? [end.error, ...cleanupErrors] : cleanupErrors);
    this.#hooks.end(end, diagnostic, this.#releaseOwnsReads ? streamFailure(cleanupErrors) : diagnostic);
    this.#finished = true;
    this.#birthSignal.removeEventListener('abort', this.#onAbort);
    this.move(undefined);
    if (errors.length) throw combineErrors(errors, `Closing stream "${this.handle.label}" failed`);
  }
}

const cursorOf = <T>(inner: StreamResource<T>) => {
  let pending: Promise<Pull<T>> | undefined;
  let reading: Promise<Pull<T>> | undefined;
  let releasing = false;
  const read = async (signal?: AbortSignal): Promise<Pull<T>> => {
    try {
      const task = pending ??= inner.pull();
      const result = signal ? await raceAbort(task, signal) : await task;
      if (result === aborted) {
        void task.catch(() => undefined);
        return done;
      }
      pending = undefined;
      return result;
    } catch (error) {
      pending = undefined;
      throw error;
    }
  };
  const next = (signal?: AbortSignal): Promise<Pull<T>> => {
    if (signal?.aborted) return Promise.resolve(done);
    if (reading !== undefined) return Promise.reject(new ConcurrentStreamReadError(inner.handle.label));
    reading = read(signal);
    const clear = (): void => { reading = undefined; };
    void reading.then(clear, clear);
    return reading;
  };
  const assertReleasing = (): void => {
    if (!releasing) throw new StreamOwnershipError(inner.handle.label, 'release hook');
  };
  const loan: ReleasingInner<T> = {
    [Symbol.asyncIterator]: () => {
      assertReleasing();
      return loan;
    },
    next: async () => {
      assertReleasing();
      return await next();
    },
    close: async () => {
      assertReleasing();
      if (inner.ending) throw new DuplicateStreamCloseError(inner.handle.label);
      await inner.stop({ how: 'released' });
    },
    return: async () => {
      assertReleasing();
      if (!inner.finished) await inner.stop({ how: 'released' });
      return done;
    },
  };
  return {
    source: (signal: AbortSignal): AsyncIterable<T> => ({
      [Symbol.asyncIterator]: () => ({ next: () => next(signal), return: async () => done }),
    }),
    async release(end: StreamEnd): Promise<ReleasingInner<T> | null> {
      if (end.how === 'cancelled') return null;
      // A merge can exit after just one cursor wakes. Join this cursor's wait
      // before lending it; its physical read remains available to the hook.
      if (reading !== undefined) await Promise.allSettled([reading]);
      if (inner.ending && pending === undefined) return null;
      inner.handOffReadFailures();
      releasing = true;
      return loan;
    },
    revoke: () => { releasing = false; },
  };
};

export const wrapOptions = <In, Out>(inner: StreamResource<In>, options: WrapStreamOptions<In, Out>): CreateStreamOptions<Out> => {
  const cursor = cursorOf(inner);
  return {
    label: options.label,
    iterate: signal => options.transform(cursor.source(signal), signal),
    onClose: async end => {
      if (!options.onClose) return;
      try {
        await options.onClose(end, await cursor.release(end));
      } finally {
        cursor.revoke();
      }
    },
  };
};

export const wrapStreamsOptions = <Out>(
  inners: readonly (readonly [string, StreamResource<unknown>])[],
  options: WrapStreamsOptions<Record<string, unknown>, Out>,
): CreateStreamOptions<Out> => {
  const cursors = inners.map(([name, inner]) => [name, cursorOf(inner)] as const);
  return {
    label: options.label,
    iterate: signal => options.transform(Object.freeze(Object.fromEntries(cursors.map(([name, cursor]) => [name, cursor.source(signal)]))), signal),
    onClose: async end => {
      if (!options.onClose) return;
      try {
        const loans = await Promise.all(cursors.map(async ([name, cursor]) => [name, await cursor.release(end)] as const));
        await options.onClose(end, Object.freeze(Object.fromEntries(loans)));
      } finally {
        for (const [, cursor] of cursors) cursor.revoke();
      }
    },
  };
};
