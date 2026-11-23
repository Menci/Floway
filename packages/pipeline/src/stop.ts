export interface Stop {
  readonly kind: 'cancel' | 'panic' | 'timeout';
  readonly reason: unknown;
}

class InternalStop {
  constructor(readonly stop: Stop) {}
}

export class StopDomain {
  readonly #stopped = new AbortController();
  readonly #interrupted = new AbortController();
  readonly #channel: AbortSignal;
  readonly signal: AbortSignal;

  constructor(parent?: StopDomain, cancellation?: AbortSignal) {
    const stops = [this.#stopped.signal];
    const interrupts = [this.#interrupted.signal];
    if (parent) {
      stops.push(parent.#channel);
      interrupts.push(parent.signal);
    }
    if (cancellation) {
      stops.push(cancellation);
      interrupts.push(cancellation);
    }
    this.#channel = AbortSignal.any(stops);
    this.signal = AbortSignal.any(interrupts);
  }

  get stop(): Stop | undefined {
    if (!this.#channel.aborted) return undefined;
    const reason: unknown = this.#channel.reason;
    return reason instanceof InternalStop ? reason.stop : { kind: 'cancel', reason };
  }

  abort(stop: Stop): void {
    // I/O's synchronous abort listeners can observe the stop classification.
    this.#stopped.abort(new InternalStop(stop));
    this.#interrupted.abort(stop.reason);
  }
}
