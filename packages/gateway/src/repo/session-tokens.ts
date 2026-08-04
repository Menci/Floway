export const generateSessionToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return encodeHex(bytes);
};
import { encodeHex } from '../shared/base-encoding.ts';
