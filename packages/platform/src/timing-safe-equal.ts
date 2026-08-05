import { sha256Bytes } from './sha256.ts';

export type TimingSafeEqual = (a: Uint8Array, b: Uint8Array) => boolean;

let impl: TimingSafeEqual | null = null;

export const initTimingSafeEqual = (timingSafeEqual: TimingSafeEqual): void => {
  impl = timingSafeEqual;
};

const initializedImpl = (): TimingSafeEqual => {
  if (!impl) throw new Error('TimingSafeEqual not initialized — call initTimingSafeEqual() first');
  return impl;
};

// Direct comparison is appropriate for already fixed-width values such as
// password digests. Variable-width secrets must use the hashing helper below.
export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  const compare = initializedImpl();
  if (a.byteLength !== b.byteLength) return false;
  return compare(a, b);
};

// Hash both inputs before the runtime primitive sees them, keeping its work at
// a fixed width even when the caller presents a credential of the wrong length.
// https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal
export const timingSafeEqualVariableLength = async (
  a: Uint8Array,
  b: Uint8Array,
): Promise<boolean> => {
  const compare = initializedImpl();
  const [aHash, bHash] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  return compare(aHash, bHash);
};
