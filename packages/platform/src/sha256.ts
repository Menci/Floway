import { hex } from '@scure/base';

// Hex-encoded SHA-256 digest. Used for content-addressed cache keys and for
// integrity-checking spilled file payloads — anywhere the runtime needs a
// stable hash of arbitrary bytes. Web Crypto is available in every JS runtime
// that hosts this package (Workers, Node 22+, Bun, Deno).
//
// We copy the input into a fresh Uint8Array to give crypto.subtle.digest a
// concrete ArrayBuffer-backed view regardless of the caller's
// ArrayBufferLike type parameter; without the copy, TypeScript's strict
// BufferSource check fails on slices and SharedArrayBuffer-backed inputs.
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return hex.encode(new Uint8Array(digest));
};
