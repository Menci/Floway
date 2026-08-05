import { expect, test } from 'vitest';

import {
  assertRequiredCloudflareBindings,
  cloudflareEnvGetter,
  type CloudflareEnv,
} from '../src/cloudflare-env.ts';
import type { ImagesBinding } from '../src/image-processor.ts';
import type { KvNamespace } from '../src/kv-image-cache-store.ts';
import type { R2BucketLike } from '../src/r2-file-store.ts';
import type { BroadcastNamespace } from '../src/durable-object-channel-broker.ts';
import type { SqlDatabase } from '@floway-dev/platform';

const completeEnv = (): CloudflareEnv => ({
  DB: {} as SqlDatabase,
  FILES: {} as R2BucketLike,
  IMAGES: {} as ImagesBinding,
  KV: {} as KvNamespace,
  BROADCAST_DO: {} as BroadcastNamespace,
  STRING_VALUE: 'configured',
  NON_STRING_VALUE: 42,
});

test.each(['DB', 'FILES', 'IMAGES', 'KV', 'BROADCAST_DO'] as const)(
  'required Cloudflare binding validation rejects missing %s',
  binding => {
    const env: Partial<CloudflareEnv> = completeEnv();
    delete env[binding];

    expect(() => assertRequiredCloudflareBindings(env as CloudflareEnv))
      .toThrow(`Missing required Cloudflare bindings: ${binding}`);
  },
);

test('Cloudflare environment lookup exposes only string-valued variables', () => {
  const getEnv = cloudflareEnvGetter(completeEnv());

  expect(getEnv('STRING_VALUE')).toBe('configured');
  expect(getEnv('NON_STRING_VALUE')).toBeUndefined();
  expect(getEnv('MISSING_VALUE')).toBeUndefined();
});
