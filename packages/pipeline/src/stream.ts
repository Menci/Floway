import { Resource } from './custody.ts';
import type { Custody } from './custody.ts';
import type { Emit } from './events.ts';
import { freeze } from './facts.ts';
import type { ManagedStream, Result } from './values.ts';

type Frame = Result<unknown, unknown>;
export type StreamGenerator = AsyncGenerator<Frame, void, unknown>;
export type ProducerExit = (normal: boolean) => void;

const done = (): IteratorReturnResult<void> => ({ done: true, value: undefined });

export class StreamResource extends Resource<ManagedStream<unknown, unknown>> {
  #generator: StreamGenerator | undefined;
  #pending: Promise<void> = Promise.resolve();
  #yieldedError = false;

  constructor(
    id: number,
    holder: Custody,
    readonly emit: Emit,
    readonly exit: ProducerExit,
    readonly track: (work: Promise<void>) => void,
  ) {
    super('stream', id, holder);
  }

  start(generator: StreamGenerator): void {
    this.#generator = generator;
  }

  read(holder: Custody): AsyncIterableIterator<Frame> {
    this.open(holder);
    let closed = false;
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => this.#schedule(async () => {
        if (closed) return done();
        this.checkHolder(holder);
        try {
          const item = await this.#pull();
          closed = item.done === true;
          return item;
        } catch (error) {
          closed = true;
          throw error;
        }
      }),
      return: async () => {
        if (!closed && this.holder === holder) {
          throw new Error('A pipeline stream reader left before native done');
        }
        closed = true;
        return done();
      },
    };
  }

  async drain(): Promise<void> {
    await this.#schedule(async () => {
      try {
        while (!(await this.#pull()).done) {
          // A discarded stream still runs its producer and records every frame.
        }
      } catch {
        // Discard absorbs this dependency's panic. The producer recorded it.
      }
    });
  }

  #schedule<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.#pending.then(task);
    this.#pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #pull(): Promise<IteratorResult<Frame, void>> {
    if (this.settled) return done();
    const generator = this.#generator!;
    let item: IteratorResult<Frame, void> | undefined;
    try {
      item = await generator.next();
      if (item.done) {
        this.exit(true);
      } else {
        if (this.#yieldedError) throw new Error('A pipeline stream yielded after Err');
        this.#yieldedError = !item.value.ok;
        freeze(item.value);
        this.emit({ type: 'stream.frame', streamId: this.id, item: item.value });
        return item;
      }
    } catch (error) {
      if (item && !item.done) {
        this.track(this.#schedule(async () => { await this.#drainPanicked(generator); }));
      } else {
        this.exit(false);
      }
      this.release();
      this.reject(error);
      this.emit({ type: 'stream.end', streamId: this.id, error });
      throw error;
    }

    this.release();
    this.resolve();
    this.emit({ type: 'stream.end', streamId: this.id });
    return item;
  }

  async #drainPanicked(generator: StreamGenerator): Promise<void> {
    try {
      while (!(await generator.next()).done) {
        // The entity's panic has already been published.
      }
    } catch {
      // The first panic remains the stream's outcome.
    } finally {
      this.exit(false);
    }
  }
}
