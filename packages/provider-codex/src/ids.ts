import { v4, v7 } from 'uuid';

// Format the SHA-256 digest as a UUIDv4-shaped opaque identifier. This remains
// for Floway-owned stable ids where we intentionally do not mimic Codex's
// random persisted device id yet.
export const sha256Uuid = async (input: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return v4({ random: new Uint8Array(buf) });
};

export const uuidV7 = (): string => v7();
