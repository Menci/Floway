import type { RunEvent } from './events.ts';
import { registerHandle } from './facts.ts';
import type { Facts } from './facts.ts';
import type { ManagedStream, Result } from './values.ts';

export type AnyStream = StreamResource<unknown, unknown>;
export type StreamOwner = Set<AnyStream>;

const resources = new WeakMap<object, AnyStream>();
const done = Object.freeze({ done: true, value: undefined } as const);

type Pull<T, E> = IteratorResult<Result<T, E>, undefined>;
type Cursor<T, E> = AsyncIterableIterator<Result<T, E>, undefined>;

interface StreamHooks {
  readonly emit: (event: RunEvent) => void;
  readonly panic: (error: unknown) => never;
  readonly finishProducer: () => void;
}

export const resourceOf = <T, E>(stream: ManagedStream<T, E>): StreamResource<T, E> | undefined =>
  resources.get(stream) as StreamResource<T, E> | undefined;

export const streamsIn = (facts: Facts): Set<AnyStream> => {
  const found = new Set<AnyStream>();
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || visited.has(value) || ArrayBuffer.isView(value)) return;
    visited.add(value);
    const resource = resources.get(value);
    if (resource) {
      found.add(resource);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(facts);
  return found;
};

export class StreamResource<T, E> {
  readonly handle: ManagedStream<T, E>;
  readonly #completion = Promise.withResolvers<void>();
  readonly #source: (() => AsyncIterable<Result<T, E>>);
  readonly #hooks: StreamHooks;
  readonly #inner: AnyStream | undefined;
  #owner: StreamOwner | undefined;
  #iterator: AsyncIterator<Result<T, E>> | undefined;
  #finished = false;
  #failure: { readonly error: unknown } | undefined;
  #lease: object | undefined;
  #interruptRead: ((error: unknown) => void) | undefined;
  #sawError = false;
  #wrappedBy: ((error: unknown) => never) | undefined;

  constructor(
    owner: StreamOwner,
    source: () => AsyncIterable<Result<T, E>>,
    hooks: StreamHooks,
    inner?: AnyStream,
  ) {
    this.#owner = owner;
    this.#source = source;
    this.#hooks = hooks;
    this.#inner = inner;
    this.handle = registerHandle({
      [Symbol.asyncIterator]: () => {
        if (this.#wrappedBy) this.#wrappedBy(new Error('Cannot iterate a stream transferred to a wrapper'));
        return this.#open();
      },
    });
    resources.set(this.handle, this);
    owner.add(this);
    void this.done.catch(() => undefined);
  }

  get done(): Promise<void> { return this.#completion.promise; }
  get exhausted(): boolean { return this.#finished; }
  get owner(): StreamOwner | undefined { return this.#owner; }

  canTransfer(owner: StreamOwner): boolean {
    return this.#finished || (this.#owner === owner && !this.#interruptRead);
  }

  transfer(to: StreamOwner): void {
    if (this.#finished) return;
    this.#owner?.delete(this);
    this.#owner = to;
    this.#lease = undefined;
    to.add(this);
  }

  wrap(active: () => boolean, panic: (error: unknown) => never): AsyncIterable<Result<T, E>> {
    this.#owner?.delete(this);
    this.#owner = undefined;
    this.#lease = undefined;
    this.#wrappedBy = panic;
    return { [Symbol.asyncIterator]: () => this.#open(active) };
  }

  fail(error: unknown): void {
    if (this.#finished || this.#failure) return;
    this.#failure = { error };
    this.#hooks.finishProducer();
    this.#interruptRead?.(error);
    this.#completion.reject(error);
    const iterator = this.#iterator;
    this.#iterator = undefined;
    if (iterator?.return) {
      // The stage already carries the first panic. Closing the generator runs its
      // finally blocks without delaying panic propagation through a blocked read.
      void Promise.resolve().then(() => iterator.return!()).catch(() => undefined);
    }
  }

  #violation(message: string): never {
    return this.#hooks.panic(new Error(message));
  }

  #open(active: () => boolean = () => true): Cursor<T, E> {
    if (this.#failure) throw this.#failure.error;
    if (!active()) this.#violation('Wrapper source used outside its producer');
    if (this.#lease) this.#violation('Stream already has an iterator in this owner');
    const lease = {};
    this.#lease = lease;
    return {
      [Symbol.asyncIterator]() { return this; },
      next: async () => {
        if (!active()) this.#violation('Wrapper source used outside its producer');
        return await this.#pull(lease);
      },
      return: async () => {
        if (this.#failure) throw this.#failure.error;
        if (this.#lease !== lease) this.#violation('Stream iterator belongs to a previous owner');
        if (!this.#finished) this.#violation('Managed stream iterator returned before native done');
        return done;
      },
    };
  }

  async #pull(lease: object): Promise<Pull<T, E>> {
    if (this.#failure) throw this.#failure.error;
    if (this.#lease !== lease) this.#violation('Stream iterator belongs to a previous owner');
    if (this.#finished) return done;
    if (this.#interruptRead) this.#violation('Concurrent reads of a managed stream');
    const interruption = Promise.withResolvers<never>();
    this.#interruptRead = interruption.reject;
    void interruption.promise.catch(() => undefined);
    try {
      this.#iterator ??= this.#source()[Symbol.asyncIterator]();
      const read = this.#iterator.next();
      const item = await Promise.race([read, interruption.promise]);
      if (item.done) {
        if (this.#inner && !this.#inner.exhausted) {
          throw new Error('Wrapper reached native done before its source');
        }
        this.#hooks.finishProducer();
        this.#finished = true;
        this.#owner?.delete(this);
        this.#owner = undefined;
        this.#completion.resolve();
        this.#hooks.emit({ type: 'stream.end', stream: this.handle });
        return done;
      }
      if (this.#sawError) throw new Error('Managed stream yielded after an Err');
      if (item.value?.ok === true && Object.hasOwn(item.value, 'value')) {
        this.#hooks.emit({ type: 'stream.frame', stream: this.handle, item: item.value });
      } else if (item.value?.ok === false && Object.hasOwn(item.value, 'error')) {
        this.#sawError = true;
        this.#hooks.emit({ type: 'stream.frame', stream: this.handle, item: item.value });
      } else {
        throw new TypeError('Managed stream must yield a Result item');
      }
      return { done: false, value: item.value };
    } catch (error) {
      this.#owner?.delete(this);
      this.#owner = undefined;
      return this.#hooks.panic(error);
    } finally {
      this.#interruptRead = undefined;
    }
  }
}

export const transferStreams = (streams: ReadonlySet<AnyStream>, from: StreamOwner, to: StreamOwner): void => {
  for (const stream of streams) {
    if (!stream.canTransfer(from)) throw new Error('Managed stream is not owned by the handing stage');
  }
  for (const stream of streams) stream.transfer(to);
};
