import { expect, test } from 'vitest';

import { bootstrapCloudflarePlatform, type CloudflareEnv } from '../src/bootstrap.ts';
import type { ImagesBinding } from '../src/image-processor.ts';
import type { KvNamespace } from '../src/kv-image-cache-store.ts';
import type { R2BucketLike } from '../src/r2-file-store.ts';
import type { BroadcastNamespace } from '../src/durable-object-channel-broker.ts';
import { getEnvOptional, getRuntimeKind, type SqlDatabase } from '@floway-dev/platform';

const db: SqlDatabase = {
  prepare() { throw new Error('bootstrap test DB must not be queried'); },
  exec() { return Promise.reject(new Error('bootstrap test DB must not be executed')); },
};

const files: R2BucketLike = {
  put() { return Promise.reject(new Error('bootstrap test R2 must not be written')); },
  get() { return Promise.reject(new Error('bootstrap test R2 must not be read')); },
  delete() { return Promise.reject(new Error('bootstrap test R2 must not be deleted')); },
};

const images: ImagesBinding = {
  input() { throw new Error('bootstrap test Images binding must not be called'); },
};

const kv: KvNamespace = {
  getWithMetadata() { return Promise.reject(new Error('bootstrap test KV must not be read')); },
  put() { return Promise.reject(new Error('bootstrap test KV must not be written')); },
};

const broadcast: BroadcastNamespace = {
  idFromName() { throw new Error('bootstrap test Broadcast namespace must not be addressed'); },
  get() { throw new Error('bootstrap test Broadcast namespace must not be read'); },
};

const completeEnv = (): CloudflareEnv => ({
  DB: db,
  FILES: files,
  IMAGES: images,
  KV: kv,
  BROADCAST_DO: broadcast,
  STRING_VALUE: 'configured',
  NON_STRING_VALUE: 42,
});

test.each(['DB', 'FILES', 'IMAGES', 'KV', 'BROADCAST_DO'] as const)(
  'bootstrapCloudflarePlatform rejects missing %s before using any binding',
  binding => {
    const env: Partial<CloudflareEnv> = completeEnv();
    delete env[binding];

    expect(() => bootstrapCloudflarePlatform(env as CloudflareEnv))
      .toThrow(`Missing required Cloudflare bindings: ${binding}`);
  },
);

test('bootstrapCloudflarePlatform installs its runtime and string environment boundaries', () => {
  const result = bootstrapCloudflarePlatform(completeEnv());

  expect(result.db).toBe(db);
  expect(getRuntimeKind()).toBe('cloudflare');
  expect(getEnvOptional('STRING_VALUE', 'fallback')).toBe('configured');
  expect(getEnvOptional('NON_STRING_VALUE', 'fallback')).toBe('fallback');
  expect(getEnvOptional('MISSING_VALUE', 'fallback')).toBe('fallback');
});
