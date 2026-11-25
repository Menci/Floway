import { objectChildren } from './facts.ts';
import type { Facts, Handle } from './values.ts';

const resources = new WeakMap<object, Resource>();

export abstract class Resource<H extends Handle = Handle> {
  readonly handle = Object.freeze({}) as H;
  readonly #settlement = Promise.withResolvers<void>();
  readonly #discard = Promise.withResolvers<void>();
  #settled = false;
  #opened = false;

  protected constructor(readonly kind: 'stream' | 'deferred', readonly id: number, public holder: Custody | undefined) {
    resources.set(this.handle, this);
    holder?.add(this);
    void this.done.catch(() => undefined);
  }

  get done(): Promise<void> { return this.#settlement.promise; }
  get settled(): boolean { return this.#settled; }
  get discarded(): Promise<void> { return this.#discard.promise; }

  checkTransfer(from: Custody): void {
    this.checkHolder(from);
    if (this.#opened) throw new Error(`Cannot transfer an opened ${this.kind}`);
  }

  checkHolder(holder: Custody): void {
    if (this.holder !== holder) throw new Error(`Cannot access a ${this.kind} held by another executor`);
  }

  open(holder: Custody): void {
    if (this.#opened) throw new Error(`Cannot open a ${this.kind} twice`);
    this.checkHolder(holder);
    this.#opened = true;
  }

  release(): void {
    this.holder?.remove(this);
    this.holder = undefined;
  }

  discard(): Promise<void> {
    this.release();
    this.#discard.resolve();
    return this.drain();
  }

  protected resolve(): void {
    this.#settled = true;
    this.#settlement.resolve();
  }

  protected reject(error: unknown): void {
    this.#settled = true;
    this.#settlement.reject(error);
  }

  abstract drain(): Promise<void>;
}

export const resourceOf = (handle: object): Resource | undefined => resources.get(handle);

export const resourcesIn = (facts: Facts): Set<Resource> => {
  const pending: object[] = [facts];
  const seen = new WeakSet<object>();
  const found = new Set<Resource>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const resource = resourceOf(current);
    if (resource) {
      found.add(resource);
    } else if (!ArrayBuffer.isView(current)) {
      for (const child of objectChildren(current)) pending.push(child);
    }
  }
  return found;
};

export class Custody {
  readonly #held = new Set<Resource>();

  get size(): number { return this.#held.size; }

  add(resource: Resource): void { this.#held.add(resource); }
  remove(resource: Resource): void { this.#held.delete(resource); }

  resource(handle: Handle): Resource {
    const resource = resourceOf(handle);
    if (!resource) throw new TypeError('Expected a pipeline stream or deferred handle');
    return resource;
  }

  transfer(resources: ReadonlySet<Resource>, destination: Custody): void {
    for (const resource of resources) resource.checkTransfer(this);
    for (const resource of resources) {
      this.#held.delete(resource);
      resource.holder = destination;
      destination.add(resource);
    }
  }

  transferAnswer(resources: ReadonlySet<Resource>, destination: Custody, where: string): void {
    for (const resource of resources) resource.checkTransfer(this);
    const retained = this.size - resources.size;
    if (retained > 0) throw new Error(`${where} leaked ${retained} stream or deferred handle(s)`);
    this.transfer(resources, destination);
  }

  discard(resource: Resource): Promise<void> {
    resource.checkHolder(this);
    return resource.discard();
  }

  discardAll(): Promise<void>[] {
    return [...this.#held].map(resource => this.discard(resource));
  }
}
