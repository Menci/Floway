import { encodeHex } from '@floway-dev/protocols/common';

export const generateSessionToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return encodeHex(bytes);
};
