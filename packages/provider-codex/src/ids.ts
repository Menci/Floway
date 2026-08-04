// Format the SHA-256 digest as a UUIDv4-shaped opaque identifier. This remains
// for Floway-owned stable ids where we intentionally do not mimic Codex's
// random persisted device id yet.
export const sha256Uuid = async (input: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const bytes = new Uint8Array(buf);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return uuidFromBytes(bytes);
};

export const uuidV7 = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const timestampMs = BigInt(Date.now());
  bytes[0] = Number((timestampMs >> 40n) & 0xffn);
  bytes[1] = Number((timestampMs >> 32n) & 0xffn);
  bytes[2] = Number((timestampMs >> 24n) & 0xffn);
  bytes[3] = Number((timestampMs >> 16n) & 0xffn);
  bytes[4] = Number((timestampMs >> 8n) & 0xffn);
  bytes[5] = Number(timestampMs & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return uuidFromBytes(bytes);
};

const uuidFromBytes = (bytes: Uint8Array): string => {
  const encoded = hex.encode(bytes);
  return `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`;
};
import { hex } from '@scure/base';
