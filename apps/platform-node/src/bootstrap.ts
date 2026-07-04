import { EventTargetChannelBroker } from './event-target-channel-broker.ts';
import { FsFileProvider } from './fs-file-provider.ts';
import { InProcessDurableHttpSession } from './in-process-durable-http-session.ts';
import { createNodeSqliteDatabase } from './node-sqlite-database.ts';
import { createSharpImageProcessor } from './sharp-image-processor.ts';
import { nodeSocketDial } from './socket-dial.ts';
import { SqliteImageCache } from './sqlite-image-cache.ts';
import { nodeRuntimeRootCAs } from './tls-trust.ts';
import { FileDumpStore, initDumpBroker, initDumpStore } from '@floway-dev/gateway';
import { dumpCodec } from '@floway-dev/gateway/dump-codec';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  getEnvOptional,
  IMAGE_CACHE_POLICY,
  initDurableHttpSession,
  initEnv,
  initFileProvider,
  initImageCacheStore,
  initImageProcessor,
  initRuntimeKind,
  initSocketDial,
  type SqlDatabase,
} from '@floway-dev/platform';

export const bootstrapNodePlatform = (): { db: SqlDatabase } => {
  initEnv(name => process.env[name]);
  initRuntimeKind('node');

  const filesDir = getEnvOptional('FLOWAY_FILES_DIR', './data/files');
  const dbPath = getEnvOptional('FLOWAY_DB_PATH', './data/floway.db');

  const files = new FsFileProvider(filesDir);
  initFileProvider(files);
  initSocketDial(nodeSocketDial);
  addTrustedRootCAs(nodeRuntimeRootCAs);
  const db = createNodeSqliteDatabase(dbPath);
  initImageCacheStore(new SqliteImageCache(db, IMAGE_CACHE_POLICY));
  initImageProcessor(createSharpImageProcessor());
  initDumpStore(new FileDumpStore(db, files));
  initDumpBroker(new EventTargetChannelBroker<DumpMetadata>(dumpCodec));
  initDurableHttpSession(new InProcessDurableHttpSession());
  return { db };
};
