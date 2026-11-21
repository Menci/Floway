import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { SECRET_BRAND, SECRET_RENDERED } from './types.ts';
import type { Secret, StoredSecret } from './types.ts';

let secretCreatedListener: ((rendered: string) => void) | null = null;

const hashRendered = (rendered: string): string =>
  `0x${bytesToHex(sha256(utf8ToBytes(rendered))).slice(0, 16)}`;

export function secret(value: string): Secret<string>;
export function secret<T>(value: T, render: (value: T) => string): Secret<T>;
export function secret<T>(value: T, render?: (value: T) => string): Secret<T> {
  const rendered = render ? render(value) : value as string;
  const result: Secret<T> = Object.freeze({
    [SECRET_BRAND]: true as const,
    [SECRET_RENDERED]: rendered,
    length: rendered.length,
    hash: hashRendered(rendered),
    reveal: () => value,
  });

  secretCreatedListener?.(rendered);
  return result;
}

export const isSecret = (value: unknown): value is Secret<unknown> =>
  typeof value === 'object' && value !== null && SECRET_BRAND in value;

export const storedSecret = (value: Secret<unknown>): StoredSecret => Object.freeze({
  length: value.length,
  hash: value.hash,
  redacted: '*'.repeat(Math.min(value.length, 64)),
});

export const onSecretCreated = (listener: ((rendered: string) => void) | null): void => {
  secretCreatedListener = listener;
};
