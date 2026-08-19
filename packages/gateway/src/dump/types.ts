// Per-API-key request-dump types. Three shapes split by lifecycle:
//
//   - the write shape (`DumpWrite*`) carries a request body prepared while the
//     upstream is running, so persistence does not need the original bytes;
//   - the storage/read shape (`Stored*`, with `body: Uint8Array`) is what the
//     store rehydrates and what flows in-process to the dashboard's reader;
//   - the wire shape (`Dump*`, with `body: DumpBody`) is the JSON-friendly
//     view served to the dashboard by `dumpRecordToWire`.
//
// `DumpMetadata` and `DumpStreamEvent` are body-free and shared verbatim.
//
// Across all three, a record is one of two shapes, and `shape` is what a reader
// dispatches on. An endpoint served by the onion records its **edges** — what
// the client sent and what the client got back. An endpoint served by a
// pipeline records the **whole run**: every stage, both directions, as the
// NDJSON event stream `@floway-dev/pipeline` encodes. The edges are still in
// that stream; they are the first and last things it holds. The shape follows
// the endpoint, so both are alive for as long as the two mechanisms are.
//
// What stays common is `DumpMetadata`: the dashboard lists both kinds together,
// and one turn's attribution does not depend on which mechanism served it.

import type { z } from 'zod';

import type {
  dumpErrorSchema,
  dumpMetadataSchema,
  dumpStreamEventSchema,
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
// `ApiErrorResult.source`) or an uncategorized failure (anything the
// respond layer caught or observed mid-flight: thrown
// exceptions, source-emitted error events, downstream cancels, write
// errors) carrying its one-line reason text. The categorized form stores
// no status — `DumpMetadata.status` already does.
export type DumpErrorMeta = z.infer<typeof dumpErrorSchema>;

export type DumpMetadata = z.infer<typeof dumpMetadataSchema>;

// Canonical protocol frame the gateway's respond layer fans out to every
// dump-enabled key. Stored as ProtocolFrame (not the SSE-serialized form)
// so the gateway's live fold and the dashboard's cold fold can share the
// same `collectXProtocolEventsToResult` reducer; the SSE wire view is
// derived on demand by the dashboard via `XProtocolFrameToSSEFrame`.
//
// `unknown` for the event payload because the storage layer is protocol-
// agnostic — the dashboard dispatches the right per-protocol serializer
// based on `meta.path`.
export type DumpStreamEvent = z.infer<typeof dumpStreamEventSchema>;
// The run's NDJSON, still as bytes: it is a body file under the same contract
// as the other two, gzipped into the file store and pointed at by the row's
// descriptor. One `put` carries it whole — measured on production, P99 of a
// turn's request and response together is 2.86 MB, well under the 5 MiB below
// which multipart has nothing to divide.
export type StoredDumpRecord = {
  meta: DumpMetadata;
  events: Uint8Array;
};

// A run's stream is encoded once the run is over, so there is nothing to
// compress ahead of the terminal write the way a request body was.
export type DumpWriteRecord = StoredDumpRecord;
// The stored NDJSON verbatim, decoded as UTF-8. One line is one event and one
// SSE `data:` payload, so what a reader parses here is what a live observer
// will parse frame by frame once the fan-out exists.
export type DumpRecord = {
  meta: DumpMetadata;
  events: string;
};
