import { UnsettledDeferredError } from './errors.ts';
import type { Trace } from './events.ts';
import { freezeData } from './facts.ts';
import { deferreds } from './handles.ts';
import type { Deferred, DeferredHandle } from './handles.ts';

const ids = new WeakMap<Deferred<unknown>, number>();

export interface OwnerDeferredFailure {
  readonly error: unknown;
}

export const deferredIdOf = (deferred: Deferred<unknown>): number => {
  const id = ids.get(deferred);
  if (id === undefined) throw new TypeError('Expected an admitted deferred');
  return id;
};

export class DeferredResource<T> {
  readonly handle: DeferredHandle<T>;
  readonly #settlement = Promise.withResolvers<T>();
  readonly #id: number;
  #status: 'pending' | 'settled' | 'expired' = 'pending';
  #failure: OwnerDeferredFailure | undefined;

  constructor(readonly name: string, readonly trace: Trace, stageId: number, readonly isExpired: () => boolean) {
    this.#id = trace.deferredId();
    const deferred = Object.freeze({ name, promise: this.#settlement.promise });
    deferreds.set(deferred, trace.membership);
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
      if (this.#status === 'pending') this.#settle(value, false);
    }, error => {
      if (this.#status === 'pending') this.#reject(error);
    });
  }

  ownerEnded(): OwnerDeferredFailure | undefined {
    if (this.#status === 'pending') this.#reject(new UnsettledDeferredError(this.name));
    return this.#failure;
  }

  abort(error: unknown): void {
    if (this.#status === 'pending') {
      this.#status = 'expired';
      this.#fail(error);
    }
  }

  #claim(): boolean {
    if (this.#status === 'expired' || this.isExpired()) return false;
    if (this.#status === 'settled') throw new Error(`Deferred "${this.name}" has already settled`);
    this.#status = 'settled';
    return true;
  }

  #settle(value: T, throwInvalid = true): void {
    if (!this.#claim()) return;
    try {
      freezeData(value, `deferred(${this.name})`);
    } catch (error) {
      this.#fail(error);
      if (throwInvalid) throw error;
      return;
    }
    this.#settlement.resolve(value);
    this.trace.emit({ k: 'settled', deferredId: this.#id, ok: true, value });
  }

  #reject(error: unknown): void {
    if (this.#claim()) this.#fail(error);
  }

  #fail(error: unknown): void {
    this.#failure = { error };
    this.#settlement.reject(error);
    this.trace.emit({ k: 'settled', deferredId: this.#id, ok: false, error: this.trace.snapshot(error) });
  }
}
