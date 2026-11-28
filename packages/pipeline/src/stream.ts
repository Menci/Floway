import { Resource } from './custody.ts';
import type { Custody } from './custody.ts';
import { freeze } from './facts.ts';
import type { ManagedStream, Result, StreamCursor } from './values.ts';

type Frame = Result<unknown, unknown>;
export type StreamGenerator = AsyncGenerator<Frame, void, unknown>;

const done = (): IteratorReturnResult<void> => ({ done: true, value: undefined });

interface Producer {
  readonly generator: StreamGenerator;
  readonly exit: (normal: boolean) => void;
  readonly finish: () => void;
}

export class StreamResource extends Resource<ManagedStream<unknown, unknown>> {
  #producer: Producer | undefined;
  #pending: Promise<void> = Promise.resolve();
  #yieldedError = false;
  #errDelivered = false;
  #hasPanic = false;
  #panic: unknown = undefined;

  constructor(holder: Custody, producer: Producer) {
    if (!producer.generator || typeof producer.generator.next !== 'function') {
      throw new TypeError('A pipeline stream factory must return an AsyncGenerator');
    }
    super('stream', holder);
    this.#producer = producer;
  }

  override get autoDrainOnExit(): boolean {
    return this.#errDelivered && !this.#hasPanic;
  }

  read(holder: Custody, onDiscard: () => void): StreamCursor<unknown, unknown> {
    this.open(holder);
    let finished = false;
    return {
      [Symbol.asyncIterator]() { return this; },
      discard: () => { onDiscard(); },
      next: async () => {
        if (this.discarded) this.checkHolder(holder);
        if (this.#hasPanic) throw this.#panic;
        if (!finished) this.checkHolder(holder);
        if (finished) return done();
        return await this.#schedule(async () => {
          try {
            const item = await this.#pull();
            if (item.done) {
              finished = true;
            } else if (!item.value.ok) {
              this.#errDelivered = true;
            }
            return item;
          } catch (error) {
            finished = true;
            throw error;
          }
        });
      },
      return: async () => done(),
    };
  }

  protected drain(): Promise<void> {
    return this.#schedule(async () => {
      if (this.#hasPanic || !this.#producer) return;
      while (!(await this.#pull()).done) {
        // Discard drives the producer solely via next() without generator.return().
      }
    });
  }

  #schedule<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.#pending.then(task);
    this.#pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #pull(): Promise<IteratorResult<Frame, void>> {
    if (this.#hasPanic) throw this.#panic;
    const producer = this.#producer;
    if (!producer) return done();

    let item: IteratorResult<Frame, void>;
    try {
      item = await producer.generator.next();
    } catch (error) {
      this.#fail(producer, error);
      throw error;
    }
    if (item.done) {
      try {
        this.#end(producer, true);
      } catch (error) {
        this.#hasPanic = true;
        this.#panic = error;
        throw error;
      }
      return item;
    }
    try {
      const frame = item.value as unknown;
      if (typeof frame !== 'object' || frame === null || typeof (frame as { ok?: unknown }).ok !== 'boolean') {
        throw new TypeError('A pipeline stream yielded a non-Result frame');
      }
      if (this.#yieldedError) throw new Error('A pipeline stream yielded after Err');
      this.#yieldedError = !(frame as Frame).ok;
      freeze(frame);
      return item;
    } catch (error) {
      this.#fail(producer, error);
      throw error;
    }
  }

  #fail(producer: Producer, error: unknown): void {
    this.#hasPanic = true;
    this.#panic = error;
    this.#end(producer, false);
  }

  #end(producer: Producer, normal: boolean): void {
    this.#producer = undefined;
    this.release();
    try {
      producer.exit(normal);
    } finally {
      this.settle();
      producer.finish();
    }
  }
}
