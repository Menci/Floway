declare const secretType: unique symbol;
const values = new WeakMap<object, unknown>();
const redacted = '[secret]';
const inspect = Symbol.for('nodejs.util.inspect.custom');

export interface Secret<out T> {
  readonly [secretType]: T;
  map<U>(project: (value: T) => U): Secret<U>;
}

class MarkedSecret<T> implements Secret<T> {
  declare readonly [secretType]: T;

  constructor(value: T) {
    values.set(this, value);
    Object.freeze(this);
  }

  map<U>(project: (value: T) => U): Secret<U> {
    return secret(project(revealSecret(this)));
  }

  toJSON(): string { return redacted; }
  toString(): string { return redacted; }
  [Symbol.toPrimitive](): string { return redacted; }
  [inspect](): string { return redacted; }
}

export const secret = <T>(value: T): Secret<T> => new MarkedSecret(value);

export const revealSecret = <T>(value: Secret<T>): T => {
  if (!values.has(value)) throw new TypeError('Expected a pipeline secret');
  return values.get(value) as T;
};

export const secretValue = (object: object): unknown => values.get(object);
