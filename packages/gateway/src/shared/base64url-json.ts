// Plain base64url(JSON) codec used by both the Anthropic Messages web-search shim and
// the OpenAI Responses compact shim to round-trip private payloads through an
// opaque-string slot on the wire (`encrypted_content`, `encrypted_index`).
// No envelope or prefix marker — foreign upstream blobs are detected
// structurally by decode failure or shim-side schema mismatch, so the same
// slot remains forward-compatible with a native-compaction upstream's own
// opaque content.

import { decodeForgivingBase64url, encodeBase64url } from '@floway-dev/protocols/common';

const base64UrlToBytes = (value: string): Uint8Array | null => {
  try {
    return decodeForgivingBase64url(value);
  } catch {
    return null;
  }
};

export const encodeBase64UrlJson = (payload: unknown): string =>
  encodeBase64url(new TextEncoder().encode(JSON.stringify(payload)));

export const decodeBase64UrlJson = (value: string): unknown | null => {
  const bytes = base64UrlToBytes(value);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};
