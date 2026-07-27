import { EventTargetChannelBroker } from './event-target-channel-broker.ts';
import { createNodeExternalResourceFetcher } from './external-resource-fetcher.ts';
import { FsFileStore } from './fs-file-store.ts';
import { createNodeSqliteDatabase } from './node-sqlite-database.ts';
import { nodeRuntimeRootCAs } from './runtime-root-cas.ts';
import { createSharpImageProcessor } from './sharp-image-processor.ts';
import { nodeSocketDial } from './socket-dial.ts';
import { SqliteImageCacheStore } from './sqlite-image-cache-store.ts';
import { FileDumpStore, initDumpBroker, initDumpStore } from '@floway-dev/gateway';
import { dumpCodec } from '@floway-dev/gateway/dump-codec';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  getEnvOptional,
  IMAGE_CACHE_POLICY,
  initEnv,
  initExternalResourceFetcher,
  initFileStore,
  initImageCacheStore,
  initImageProcessor,
  initRuntimeKind,
  initSocketDial,
  type SqlDatabase,
} from '@floway-dev/platform';

export const bootstrapNodePlatform = (): { db: SqlDatabase } => {
  initEnv(name => process.env[name]);
  initRuntimeKind('node');
  initExternalResourceFetcher(createNodeExternalResourceFetcher());

  const filesDir = getEnvOptional('FLOWAY_FILES_DIR', './data/files');
  const dbPath = getEnvOptional('FLOWAY_DB_PATH', './data/floway.db');

  const files = new FsFileStore(filesDir);
  initFileStore(files);
  initSocketDial(nodeSocketDial);
  addTrustedRootCAs(nodeRuntimeRootCAs);
  const db = createNodeSqliteDatabase(dbPath);
  initImageCacheStore(new SqliteImageCacheStore(db, IMAGE_CACHE_POLICY));
  initImageProcessor(createSharpImageProcessor());
  initDumpStore(new FileDumpStore(db, files));
  initDumpBroker(new EventTargetChannelBroker<DumpMetadata>(dumpCodec));
  return { db };
};
