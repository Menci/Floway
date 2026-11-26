export class Call {
  readonly #controller = new AbortController();
  #onSettled: (() => void) | undefined;
  readonly signal: AbortSignal;
  #pending = 1;

  constructor(parent: AbortSignal, onSettled?: () => void) {
    this.signal = AbortSignal.any([parent, this.#controller.signal]);
    this.#onSettled = onSettled;
  }

  abort(reason?: unknown): void {
    if (this.#pending > 0 && !this.signal.aborted) this.#controller.abort(reason);
  }

  retain(): () => void {
    this.#pending += 1;
    return () => this.release();
  }

  release(): void {
    this.#pending -= 1;
    if (this.#pending === 0) {
      const onSettled = this.#onSettled;
      this.#onSettled = undefined;
      onSettled?.();
    }
  }
}
