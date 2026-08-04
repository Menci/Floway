import { stringify, v7 } from 'uuid';

// Format the SHA-256 digest as a UUIDv4-shaped opaque identifier. This remains
// for Floway-owned stable ids where we intentionally do not mimic Codex's
// random persisted device id yet.
export const sha256Uuid = async (input: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const bytes = new Uint8Array(buf, 0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return stringify(bytes);
};

export const uuidV7 = (): string => v7();
