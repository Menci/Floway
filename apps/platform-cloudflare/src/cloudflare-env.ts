import type { BroadcastNamespace } from './durable-object-channel-broker.ts';
import type { ImagesBinding } from './image-processor.ts';
import type { KvNamespace } from './kv-image-cache-store.ts';
import type { R2BucketLike } from './r2-file-store.ts';
import type { EnvGetter, SqlDatabase } from '@floway-dev/platform';

export interface CloudflareEnv {
  DB: SqlDatabase;
  FILES: R2BucketLike;
  IMAGES: ImagesBinding;
  KV: KvNamespace;
  BROADCAST_DO: BroadcastNamespace;
  [key: string]: unknown;
}

const REQUIRED_BINDINGS = ['DB', 'FILES', 'IMAGES', 'KV', 'BROADCAST_DO'] as const;

export const assertRequiredCloudflareBindings = (env: CloudflareEnv): void => {
  const missing = REQUIRED_BINDINGS.filter(name => env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Cloudflare bindings: ${missing.join(', ')}. `
      + 'Declare them in wrangler.jsonc; see wrangler.example.jsonc.',
    );
  }
};

export const cloudflareEnvGetter = (env: CloudflareEnv): EnvGetter => name => {
  const value = env[name];
  return typeof value === 'string' ? value : undefined;
};
