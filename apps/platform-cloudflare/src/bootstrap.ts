import { DurableObjectExecutionCellNamespace, type ExecutionDurableObjectNamespace } from './durable-object-execution-cell.ts';
import { ExecutionCellChannelBroker } from './execution-cell-channel-broker.ts';
import { createCloudflareExternalResourceFetcher } from './external-resource-fetcher.ts';
import { createCloudflareImageProcessor, type ImagesBinding } from './image-processor.ts';
import { KvImageCacheStore, type KvNamespace } from './kv-image-cache-store.ts';
import { R2FileStore, type R2BucketLike } from './r2-file-store.ts';
import { cloudflareRuntimeRootCAs } from './runtime-root-cas.ts';
import { cloudflareSocketDial } from './socket-dial.ts';
import { timingSafeEqual } from './timing-safe-equal.ts';
import { FileDumpStore, initDumpBroker, initDumpStore, initExecutionCellNamespace } from '@floway-dev/gateway';
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

export interface CloudflareEnv {
  DB: SqlDatabase;
  FILES: R2BucketLike;
  IMAGES: ImagesBinding;
  KV: KvNamespace;
  EXECUTION_DO: ExecutionDurableObjectNamespace;
  [key: string]: unknown;
}

// Every binding declared on `CloudflareEnv` is load-bearing — D1 holds all
// config and telemetry, R2 stores file-backed response payloads and dump bodies,
// Images re-encodes images, KV memoises the results, and EXECUTION_DO hosts
// WebSocket fan-out plus per-use execution cells. A missing binding means
// wrangler.jsonc drifted from the code, so we refuse to initialise rather
// than 503 on first use of the absent binding.
const REQUIRED_BINDINGS = ['DB', 'FILES', 'IMAGES', 'KV', 'EXECUTION_DO'] as const;

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
  initTimingSafeEqual(timingSafeEqual);
  initExternalResourceFetcher(createCloudflareExternalResourceFetcher());
  const files = new R2FileStore(env.FILES);
  initFileStore(files);
  initImageCacheStore(new KvImageCacheStore(env.KV, IMAGE_CACHE_POLICY));
  initImageProcessor(createCloudflareImageProcessor(env.IMAGES));
  initSocketDial(cloudflareSocketDial);
  addTrustedRootCAs(cloudflareRuntimeRootCAs);
  initDumpStore(new FileDumpStore(env.DB, files));
  const executionCells = new DurableObjectExecutionCellNamespace(env.EXECUTION_DO);
  initExecutionCellNamespace(executionCells);
  initDumpBroker(new ExecutionCellChannelBroker<DumpMetadata>(executionCells, dumpCodec));
  return { db: env.DB };
};
