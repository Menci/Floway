import type { ImageCachePolicy, ImageCacheStore } from '@floway-dev/platform';

// Minimal shape of the Cloudflare KV binding we depend on. Hand-typed so the
// runtime contract does not pull in the full @cloudflare/workers-types
// surface. We need `getWithMetadata` and `put` with a `metadata` field so the
// store can stamp each entry with its write time and decide whether a hit
// needs a TTL refresh — see the per-key write rate limit at
// https://developers.cloudflare.com/kv/platform/limits/.
export interface KvNamespace {
  getWithMetadata<TMetadata>(
    key: string,
    type: 'arrayBuffer',
  ): Promise<{ value: ArrayBuffer | null; metadata: TMetadata | null }>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
}

interface CacheEntryMetadata {
  writtenAt: number;
}

// CF KV requires `expirationTtl` in seconds with a 60-second minimum
// (https://developers.cloudflare.com/kv/api/write-key-value-pairs/#expiring-keys).
// Image-cache callers always pass a TTL in the days range, so the floor is
// academic, but rounding up keeps very-short TTLs valid in case a caller ever
// asks for one.
const KV_MIN_TTL_SECONDS = 60;

const ttlSeconds = (ttlMs: number): number => Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ttlMs / 1000));

export class KvImageCacheStore implements ImageCacheStore {
  constructor(private readonly kv: KvNamespace, private readonly policy: ImageCachePolicy) {}

  async get(key: string): Promise<Uint8Array | null> {
    const { value, metadata } = await this.kv.getWithMetadata<CacheEntryMetadata>(key, 'arrayBuffer');
    if (!value) return null;
    const now = Date.now();
    // Entries written by older deploys carry no `writtenAt` metadata; treat
    // them as past the refresh threshold so the next read stamps the current
    // metadata shape onto them.
    const age = metadata ? now - metadata.writtenAt : Infinity;
    if (age >= this.policy.refreshIfOlderThanMs) {
      // Awaited so the refresh actually lands — Workers would otherwise drop
      // a fire-and-forget write without an explicit `waitUntil`.
      await this.kv.put(key, value, {
        expirationTtl: ttlSeconds(this.policy.ttlMs),
        metadata: { writtenAt: now } satisfies CacheEntryMetadata,
      });
    }
    return new Uint8Array(value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.kv.put(key, value, {
      expirationTtl: ttlSeconds(this.policy.ttlMs),
      metadata: { writtenAt: Date.now() } satisfies CacheEntryMetadata,
    });
  }

  // KV evicts via the per-key `expirationTtl` set at write time, so the
  // central scheduled-maintenance hook has nothing to do here.
  sweepExpired(_now: number): Promise<void> {
    return Promise.resolve();
  }
}
