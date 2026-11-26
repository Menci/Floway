import { Resource } from './custody.ts';
import type { Custody } from './custody.ts';
import { freeze } from './facts.ts';
import type { Deferred } from './values.ts';

export class DeferredResource extends Resource<Deferred<unknown>> {
  #value: Promise<unknown> | undefined;

  constructor(holder: Custody, work: Promise<unknown>, exit: (normal: boolean) => void, finish: () => void) {
    super('deferred', holder);
    this.#value = work.then(value => {
      try {
        freeze(value);
        exit(true);
        return value;
      } catch (error) {
        exit(false);
        throw error;
      }
    }, error => {
      exit(false);
      throw error;
    }).finally(() => {
      this.settle();
      finish();
    });
    // A producer can settle before the holder opens, transfers or discards it.
    void this.#value.catch(() => undefined);
  }

  read(holder: Custody): Promise<unknown> {
    this.open(holder);
    this.release();
    return this.#takeValue();
  }

  protected async drain(): Promise<void> {
    await this.#takeValue();
  }

  #takeValue(): Promise<unknown> {
    const value = this.#value;
    if (!value) throw new Error('The deferred value was already released');
    this.#value = undefined;
    return value;
  }
}
