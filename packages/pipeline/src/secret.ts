import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const placeholder = '[Secret]';
const inspect = Symbol.for('nodejs.util.inspect.custom');

export class Secret<out T> {
  readonly #value: T & string;

  private constructor(value: T & string) {
    this.#value = value;
  }

  static from(value: string): Secret<string> {
    if (typeof value !== 'string') throw new TypeError('Expected a string secret');
    return new Secret(value);
  }

  map<U extends string>(project: (value: T) => U): Secret<U> {
    return Secret.from(project(this.#value)) as Secret<U>;
  }

  reveal(): T {
    return this.#value;
  }

  describe() {
    const { length } = this.#value;
    return Object.freeze({
      length,
      redacted: '*'.repeat(Math.min(length, 64)),
      hash: `0x${bytesToHex(sha256(utf8ToBytes(this.#value))).slice(0, 16)}`,
    });
  }

  toJSON(): string { return placeholder; }
  toString(): string { return placeholder; }
  [Symbol.toPrimitive](): string { return placeholder; }
  [inspect](): string { return placeholder; }
}
