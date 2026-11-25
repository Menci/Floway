import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const inspect = Symbol.for('nodejs.util.inspect.custom');
declare const secretType: unique symbol;
const values = new WeakMap<Secret<string>, string>();

export class Secret<out T extends string> {
  declare readonly [secretType]: T;

  private constructor(value: T) {
    values.set(this, value);
  }

  static from<T extends string>(value: T): Secret<T> {
    return new Secret(value);
  }

  map<U extends string>(project: (value: T) => U): Secret<U> {
    return Secret.from(project(revealSecret(this)));
  }

  describe() {
    const value = revealSecret(this);
    const { length } = value;
    return Object.freeze({
      length,
      redacted: '*'.repeat(Math.min(length, 64)),
      hash: `0x${bytesToHex(sha256(utf8ToBytes(value))).slice(0, 16)}`,
    });
  }

  toJSON() { return this.describe(); }
  [inspect]() { return this.describe(); }
}

export const revealSecret = <T extends string>(secret: Secret<T>): T => {
  const value = values.get(secret);
  if (value === undefined) throw new TypeError('Expected a pipeline secret');
  return value as T;
};
