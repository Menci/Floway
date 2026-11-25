import { Resource } from './custody.ts';
import type { Custody } from './custody.ts';
import type { Emit } from './events.ts';
import { freeze } from './facts.ts';
import type { ProducerExit } from './stream.ts';
import type { Deferred } from './values.ts';

export class DeferredResource extends Resource<Deferred<unknown>> {
  readonly #value = Promise.withResolvers<unknown>();

  constructor(id: number, holder: Custody, readonly emit: Emit, readonly exit: ProducerExit) {
    super('deferred', id, holder);
    void this.#value.promise.catch(() => undefined);
  }

  start(work: Promise<unknown>): void {
    void this.#produce(work).then(value => {
      this.#value.resolve(value);
      this.resolve();
      this.emit({ type: 'deferred.settled', deferredId: this.id, value });
    }, error => {
      this.exit(false);
      this.#value.reject(error);
      this.reject(error);
      this.emit({ type: 'deferred.settled', deferredId: this.id, error });
    });
  }

  read(holder: Custody): Promise<unknown> {
    this.open(holder);
    this.release();
    return this.#value.promise;
  }

  async drain(): Promise<void> {
    await this.done.catch(() => undefined);
  }

  async #produce(work: Promise<unknown>): Promise<unknown> {
    const value = freeze(await work);
    this.exit(true);
    return value;
  }
}
