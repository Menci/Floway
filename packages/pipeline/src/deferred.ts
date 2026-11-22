import { UnsettledDeferredError } from './errors.ts';
import type { Trace } from './events.ts';
import { freezeValue } from './facts.ts';
import { deferreds } from './handles.ts';
import type { Deferred, DeferredHandle } from './handles.ts';

const ids = new WeakMap<Deferred<unknown>, number>();

export const deferredIdOf = (deferred: Deferred<unknown>): number => {
  const id = ids.get(deferred);
  if (id === undefined) throw new TypeError('Expected an admitted deferred');
  return id;
};

export class DeferredResource<T> {
  readonly handle: DeferredHandle<T>;
  readonly #settlement = Promise.withResolvers<T>();
  readonly #id: number;
  #pending = true;

  constructor(readonly name: string, readonly trace: Trace, stageId: number) {
    this.#id = trace.deferredId();
    const deferred = Object.freeze({ name, promise: this.#settlement.promise });
    deferreds.add(deferred);
    ids.set(deferred, this.#id);
    this.handle = Object.freeze({
      deferred,
      resolve: (value: T) => this.#settle(value),
      reject: (error: unknown) => this.#reject(error),
    });
    trace.emit({ k: 'deferred', deferredId: this.#id, stageId, name });
  }

  attach(work: Promise<T>): void {
    void work.then(value => {
      if (this.#pending) this.#settle(value, false);
    }, error => {
      if (this.#pending) this.#reject(error);
    });
  }

  ownerEnded(): void {
    if (this.#pending) this.#reject(new UnsettledDeferredError(this.name));
  }

  abort(error: unknown): void {
    if (this.#pending) this.#reject(error);
  }

  #claim(): void {
    if (!this.#pending) throw new Error(`Deferred "${this.name}" has already settled`);
    this.#pending = false;
  }

  #settle(value: T, throwInvalid = true): void {
    this.#claim();
    try {
      freezeValue(value, `deferred(${this.name})`);
    } catch (error) {
      this.#fail(error);
      if (throwInvalid) throw error;
      return;
    }
    this.#settlement.resolve(value);
    this.trace.emit({ k: 'settled', deferredId: this.#id, ok: true, value });
  }

  #reject(error: unknown): void {
    this.#claim();
    this.#fail(error);
  }

  #fail(error: unknown): void {
    this.#settlement.reject(error);
    this.trace.emit({ k: 'settled', deferredId: this.#id, ok: false, error: this.trace.snapshot(error) });
  }
}
