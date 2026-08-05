import {
  assertRequiredCloudflareBindings,
  cloudflareEnvGetter,
  type CloudflareEnv,
} from './cloudflare-env.ts';
import { DurableObjectChannelBroker } from './durable-object-channel-broker.ts';
import { createCloudflareExternalResourceFetcher } from './external-resource-fetcher.ts';
import { createCloudflareImageProcessor } from './image-processor.ts';
import { KvImageCacheStore } from './kv-image-cache-store.ts';
import { R2FileStore } from './r2-file-store.ts';
import { cloudflareRuntimeRootCAs } from './runtime-root-cas.ts';
import { cloudflareSocketDial } from './socket-dial.ts';
import { timingSafeEqual } from './timing-safe-equal.ts';
import { FileDumpStore, initDumpBroker, initDumpStore } from '@floway-dev/gateway';
import { dumpCodec } from '@floway-dev/gateway/dump-codec';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  IMAGE_CACHE_POLICY,
  initEnv,
  initExternalResourceFetcher,
  initFileStore,
  initImageCacheStore,
  initImageProcessor,
  initRuntimeKind,
  initSocketDial,
  initTimingSafeEqual,
  type SqlDatabase,
} from '@floway-dev/platform';

// Every binding declared on `CloudflareEnv` is load-bearing — D1 holds all
// config and telemetry, R2 stores file-backed response payloads and dump bodies,
// Images re-encodes images, and KV memoises the results. A missing binding means
// wrangler.jsonc drifted from the code, so we refuse to initialise rather
// than 503 on first use of the absent binding.
export const bootstrapCloudflarePlatform = (env: CloudflareEnv): { db: SqlDatabase } => {
  assertRequiredCloudflareBindings(env);
  initEnv(cloudflareEnvGetter(env));
  initRuntimeKind('cloudflare');
  initTimingSafeEqual(timingSafeEqual);
  initExternalResourceFetcher(createCloudflareExternalResourceFetcher());
  const files = new R2FileStore(env.FILES);
  initFileStore(files);
  initImageCacheStore(new KvImageCacheStore(env.KV, IMAGE_CACHE_POLICY));
  initImageProcessor(createCloudflareImageProcessor(env.IMAGES));
  initSocketDial(cloudflareSocketDial);
  addTrustedRootCAs(cloudflareRuntimeRootCAs);
  initDumpStore(new FileDumpStore(env.DB, files));
  initDumpBroker(new DurableObjectChannelBroker<DumpMetadata>(env.BROADCAST_DO, dumpCodec));
  return { db: env.DB };
};

export type { CloudflareEnv } from './cloudflare-env.ts';
