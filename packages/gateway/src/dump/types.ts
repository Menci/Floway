// A dump stores the complete run's NDJSON event stream. Metadata is shared by storage,
// broker notifications and the dashboard; only the event bytes differ at the wire boundary.

import type { z } from 'zod';

import type {
  dumpErrorSchema,
  dumpMetadataSchema,
  dumpUpstreamRefSchema,
} from './schemas.ts';
import type { DumpEvent } from '@floway-dev/pipeline';

// Re-exported because the dashboard reads a run record's stream through this
// module and has no other reach into the pipeline package.
export type { DumpEvent };

export type DumpRecordId = string;

export type DumpUpstreamRef = z.infer<typeof dumpUpstreamRefSchema>;

// What went wrong on a failed turn. Either a categorized api-error envelope
// (real upstream non-2xx or a gateway-synthesized envelope — `kind` matches
// the upstream or gateway origin) or an uncategorized failure (anything the
// transport edge caught or observed mid-flight: thrown
// exceptions, source-emitted error events, downstream cancels, write
// errors) carrying its one-line reason text. The categorized form stores
// no status — `DumpMetadata.status` already does.
export type DumpErrorMeta = z.infer<typeof dumpErrorSchema>;

export type DumpMetadata = z.infer<typeof dumpMetadataSchema>;

// Detail reads rehydrate the completed NDJSON artifact. Streaming writes carry
// the same encoded bytes through DumpStore.putRun while metadata settles.
export type StoredDumpRecord = {
  meta: DumpMetadata;
  events: Uint8Array;
};

// The control plane exposes the completed UTF-8 NDJSON verbatim; the live
// byte reader receives the same encoded event stream.
export type DumpRecord = {
  meta: DumpMetadata;
  events: string;
};
