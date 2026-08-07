import { v4, v7 } from 'uuid';

import { sha256Json } from '@floway-dev/provider';

// Format SHA-256 digests as UUIDv4-shaped opaque identifiers for Floway-owned
// stable ids where we intentionally do not mimic Codex's random persisted device id.
const digestUuid = (digest: Uint8Array): string => v4({ random: digest });

export const sha256JsonUuid = async (value: unknown, prefix: string): Promise<string> =>
  digestUuid(sha256Json(value, prefix));

export const uuidV7 = (): string => v7();
