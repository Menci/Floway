import type { Call } from './cancellation.ts';
import { isNonemptyTypedArray, objectChildren } from './facts.ts';
import type { Facts, Handle } from './values.ts';

const resources = new WeakMap<object, Resource>();

export abstract class Resource<H extends Handle = Handle> {
  readonly handle = Object.freeze({}) as H;
  #holder: Custody | undefined;
  #opened = false;
  #discarded = false;
  #settled = false;
  #settlement: (() => void)[] | undefined;

  protected constructor(readonly kind: 'stream' | 'deferred', holder: Custody) {
    this.#holder = holder;
    resources.set(this.handle, this);
    holder.add(this);
  }

  get discarded(): boolean { return this.#discarded; }

  heldBy(holder: Custody): boolean { return this.#holder === holder; }

  checkHolder(holder: Custody): void {
    if (!this.heldBy(holder)) throw new Error(`Cannot access a ${this.kind} without custody`);
  }

  checkTransfer(from: Custody): void {
    this.checkHolder(from);
    if (this.#opened) throw new Error(`Cannot transfer an opened ${this.kind}`);
  }

  transfer(to: Custody): void {
    this.release();
    this.#holder = to;
    to.add(this);
  }

  open(holder: Custody): void {
    this.checkHolder(holder);
    if (this.#opened) throw new Error(`Cannot open a ${this.kind} twice`);
    this.#opened = true;
  }

  release(): void {
    this.#holder?.remove(this);
    this.#holder = undefined;
  }

  discard(holder: Custody): Promise<void> {
    this.checkHolder(holder);
    this.#discarded = true;
    this.release();
    return this.drain();
  }

  retainCall(call: Call): void {
    if (!this.#settled) (this.#settlement ??= []).push(call.retain());
  }

  protected settle(): void {
    this.#settled = true;
    const callbacks = this.#settlement;
    this.#settlement = undefined;
    if (callbacks) for (const release of callbacks) release();
  }

  protected abstract drain(): Promise<void>;
}

export const resourceOf = (handle: object): Resource | undefined => resources.get(handle);

export const requireResource = (handle: Handle): Resource => {
  const resource = resourceOf(handle);
  if (!resource) throw new TypeError('Expected a pipeline stream or deferred handle');
  return resource;
};

export const resourcesIn = (facts: Facts): Set<Resource> => {
  const pending: object[] = [facts];
  const seen = new WeakSet<object>();
  const found = new Set<Resource>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (seen.has(current)) continue;
    seen.add(current);
    const resource = resourceOf(current);
    if (resource) {
      found.add(resource);
    } else if (!isNonemptyTypedArray(current)) {
      for (const child of objectChildren(current)) pending.push(child);
    }
  }
  return found;
};

export class Custody {
  readonly #held = new Set<Resource>();
  readonly #answers = new WeakSet<Facts>();

  get size(): number { return this.#held.size; }

  add(resource: Resource): void { this.#held.add(resource); }
  remove(resource: Resource): void { this.#held.delete(resource); }

  transfer(resources: ReadonlySet<Resource>, destination: Custody): void {
    for (const resource of resources) resource.checkTransfer(this);
    for (const resource of resources) resource.transfer(destination);
  }

  discard(resource: Resource, waitUntil: (work: Promise<unknown>) => void, call?: Call): void {
    const work = resource.discard(this);
    waitUntil(call ? work.finally(call.retain()) : work);
  }

  receive(answer: Facts): void { this.#answers.add(answer); }

  discardAnswer(answer: Facts, waitUntil: (work: Promise<unknown>) => void, call?: Call): void {
    if (!this.#answers.has(answer)) throw new TypeError('Expected an answer received by this holder');
    for (const resource of resourcesIn(answer)) {
      if (resource.heldBy(this)) this.discard(resource, waitUntil, call);
    }
  }

  discardHeld(waitUntil: (work: Promise<unknown>) => void, call: Call): void {
    for (const resource of this.#held) this.discard(resource, waitUntil, call);
  }
}
