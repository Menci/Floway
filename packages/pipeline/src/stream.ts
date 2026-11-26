import { Resource } from './custody.ts';
import type { Custody } from './custody.ts';
import { freeze } from './facts.ts';
import type { ManagedStream, Result } from './values.ts';

type Frame = Result<unknown, unknown>;
export type StreamGenerator = AsyncGenerator<Frame, void, unknown>;

const done = (): IteratorReturnResult<void> => ({ done: true, value: undefined });

interface Producer {
  readonly generator: StreamGenerator;
  readonly exit: (normal: boolean) => void;
  readonly finish: () => void;
  readonly waitUntil: (work: Promise<unknown>) => void;
}

export class StreamResource extends Resource<ManagedStream<unknown, unknown>> {
  #producer: Producer | undefined;
  #pending: Promise<void> = Promise.resolve();
  #yieldedError = false;

  constructor(holder: Custody, producer: Producer) {
    super('stream', holder);
    this.#producer = producer;
  }

  read(holder: Custody): AsyncIterableIterator<Frame> {
    this.open(holder);
    let finished = false;
    return {
      [Symbol.asyncIterator]() { return this; },
      next: async () => {
        // Check custody at submission so discard only revokes future reads.
        if (this.discarded || !finished) this.checkHolder(holder);
        if (finished) return done();
        return await this.#schedule(async () => {
          try {
            const item = await this.#pull();
            finished = item.done === true;
            return item;
          } catch (error) {
            finished = true;
            throw error;
          }
        });
      },
      return: async () => {
        if (this.heldBy(holder)) throw new Error('A pipeline stream reader left before native done');
        return done();
      },
    };
  }

  protected drain(): Promise<void> {
    return this.#schedule(async () => {
      while (!(await this.#pull()).done) {
        // Discard drives the producer through its terminal work.
      }
    });
  }

  #schedule<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.#pending.then(task);
    this.#pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #pull(): Promise<IteratorResult<Frame, void>> {
    const producer = this.#producer;
    if (!producer) return done();

    let item: IteratorResult<Frame, void>;
    try {
      item = await producer.generator.next();
    } catch (error) {
      this.#end(producer, false);
      throw error;
    }
    if (item.done) {
      this.#end(producer, true);
      return item;
    }
    try {
      if (this.#yieldedError) throw new Error('A pipeline stream yielded after Err');
      this.#yieldedError = !item.value.ok;
      freeze(item.value);
      return item;
    } catch (error) {
      this.#producer = undefined;
      this.release();
      producer.waitUntil(this.#finishPanickedProducer(producer));
      throw error;
    }
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

  async #finishPanickedProducer(producer: Producer): Promise<void> {
    const { generator } = producer;
    try {
      // Enter finally from the rejected yield, then resume a suspended finally if it yields.
      for (let closing = await generator.return(undefined); !closing.done; closing = await generator.next()) {
        // The reader has already received the validation panic.
      }
    } finally {
      this.#end(producer, false);
    }
  }
}
