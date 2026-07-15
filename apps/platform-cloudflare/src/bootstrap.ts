import { DurableObjectChannelBroker, type BroadcastNamespace } from './do-channel-broker.ts';
import { createCloudflareExternalResourceFetcher } from './external-resource-fetcher.ts';
import { createCloudflareImageProcessor, type ImagesBinding } from './image-processor.ts';
import { KvImageCache, type KvNamespace } from './kv-image-cache.ts';
import { R2FileProvider, type R2BucketLike } from './r2-file-provider.ts';
import { cloudflareSocketDial } from './socket-dial.ts';
import { cloudflareRuntimeRootCAs } from './tls-trust.ts';
import { FileDumpStore, initDumpBroker, initDumpStore } from '@floway-dev/gateway';
import { dumpCodec } from '@floway-dev/gateway/dump-codec';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  IMAGE_CACHE_POLICY,
  initEnv,
  initExternalResourceFetcher,
  initFileProvider,
  initImageCacheStore,
  initImageProcessor,
  initRuntimeKind,
  initSocketDial,
  type SqlDatabase,
} from '@floway-dev/platform';

export interface CloudflareEnv {
  DB: SqlDatabase;
  FILES: R2BucketLike;
  IMAGES: ImagesBinding;
  KV: KvNamespace;
  BROADCAST_DO: BroadcastNamespace;
  [key: string]: unknown;
}

// Every binding declared on `CloudflareEnv` is load-bearing — D1 holds all
// config and telemetry, R2 holds spilled payloads, Images compresses inline
// images, KV memoises compressed image results. A missing binding means
// wrangler.jsonc drifted from the code, so we refuse to initialise rather
// than 503 on first use of the absent binding.
const REQUIRED_BINDINGS = ['DB', 'FILES', 'IMAGES', 'KV', 'BROADCAST_DO'] as const;

export const bootstrapCloudflarePlatform = (env: CloudflareEnv): { db: SqlDatabase } => {
  const missing = REQUIRED_BINDINGS.filter(name => env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Cloudflare bindings: ${missing.join(', ')}. `
      + 'Declare them in wrangler.jsonc; see wrangler.example.jsonc.',
    );
  }

  initEnv(name => {
    const value = env[name];
    if (typeof value !== 'string') return undefined;
    return value;
  });
  initRuntimeKind('cloudflare');
  initExternalResourceFetcher(createCloudflareExternalResourceFetcher());
  const files = new R2FileProvider(env.FILES);
  initFileProvider(files);
  initImageCacheStore(new KvImageCache(env.KV, IMAGE_CACHE_POLICY));
  initImageProcessor(createCloudflareImageProcessor(env.IMAGES));
  initSocketDial(cloudflareSocketDial);
  addTrustedRootCAs(cloudflareRuntimeRootCAs);
  initDumpStore(new FileDumpStore(env.DB, files));
  initDumpBroker(new DurableObjectChannelBroker<DumpMetadata>(env.BROADCAST_DO, dumpCodec));
  return { db: env.DB };
};
