import { hex } from '@scure/base';

// Hex-encoded SHA-256 digest. Used for content-addressed cache keys and for
// integrity-checking spilled file payloads — anywhere the runtime needs a
// stable hash of arbitrary bytes. Web Crypto is available in every JS runtime
// that hosts this package (Workers, Node 22+, Bun, Deno).
//
// Web Crypto requires an ArrayBuffer-backed view. Reuse ordinary buffers so
// hashing a large payload does not allocate a second payload-sized copy, while
// still copying SharedArrayBuffer-backed and cross-realm views into the type
// and memory domain Web Crypto accepts.
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digestSource = bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', digestSource);
  return hex.encode(new Uint8Array(digest));
};
