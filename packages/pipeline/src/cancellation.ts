export class Branch {
  readonly #controller = new AbortController();
  readonly #children = new Set<Branch>();
  readonly #settlement = Promise.withResolvers<void>();
  #pending = 1;
  #parent: Branch | undefined;

  constructor(parent?: Branch) {
    this.#parent = parent;
    if (parent) {
      parent.#children.add(this);
      if (parent.signal.aborted) this.abort(parent.signal.reason);
    }
  }

  get signal(): AbortSignal { return this.#controller.signal; }
  get done(): Promise<void> { return this.#settlement.promise; }

  abort(reason?: unknown): void {
    if ((this.#pending === 0 && this.#children.size === 0) || this.signal.aborted) return;
    this.#controller.abort(reason);
    for (const child of this.#children) child.abort(this.signal.reason);
  }

  track(work: Promise<unknown>): void {
    this.#pending += 1;
    const finished = (): void => { this.release(); };
    void work.then(finished, finished);
  }

  release(): void {
    this.#pending -= 1;
    this.#settle();
  }

  #settle(): void {
    if (this.#pending !== 0 || this.#children.size > 0) return;
    const parent = this.#parent;
    this.#parent = undefined;
    this.#settlement.resolve();
    if (parent) {
      parent.#children.delete(this);
      parent.#settle();
    }
  }
}
