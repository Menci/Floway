export type TimingSafeEqual = (a: Uint8Array, b: Uint8Array) => boolean;

let impl: TimingSafeEqual | null = null;

export const initTimingSafeEqual = (timingSafeEqual: TimingSafeEqual): void => {
  impl = timingSafeEqual;
};

export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (!impl) throw new Error('TimingSafeEqual not initialized — call initTimingSafeEqual() first');
  if (a.byteLength !== b.byteLength) return false;
  return impl(a, b);
};
