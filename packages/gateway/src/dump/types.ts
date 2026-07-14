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

import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { UpstreamColor, UpstreamProviderKind } from '@floway-dev/provider';

export type DumpRecordId = string;

export interface DumpUpstreamRef {
  id: string;
  name: string;
  kind: UpstreamProviderKind;
  color: UpstreamColor | null;
}

// What went wrong on a failed turn. Either a categorized api-error envelope
// (real upstream non-2xx or a gateway-synthesized envelope — `kind` matches
// `ApiErrorResult.source`) or an uncategorized failure (anything the
// respond layer / passthrough-serve caught or observed mid-flight: thrown
// exceptions, source-emitted error events, downstream cancels, write
// errors) carrying its one-line reason text. The categorized form stores
// no status — `DumpMetadata.status` already does.
export type DumpErrorMeta =
  | { kind: 'upstream' | 'gateway' }
  | { kind: 'failed'; reason: string };

export interface DumpMetadata {
  id: DumpRecordId;
  startedAt: number;        // unix ms
  completedAt: number;      // unix ms
  method: string;
  path: string;             // includes query string
  status: number | null;    // null when no upstream response status was produced
  upstream: DumpUpstreamRef | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  // Captured application-payload bytes. HTTP counts body bytes; WebSocket
  // counts UTF-8 message payloads. Transport framing/compression and the
  // dump store's gzip encoding are excluded.
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  error: DumpErrorMeta | null;
}

// Canonical protocol frame the gateway's respond layer fans out to every
// dump-enabled key. Stored as ProtocolFrame (not the SSE-serialized form)
// so the gateway's live fold and the dashboard's cold fold can share the
// same `collectXProtocolEventsToResult` reducer; the SSE wire view is
// derived on demand by the dashboard via `XProtocolFrameToSSEFrame`.
//
// `unknown` for the event payload because the storage layer is protocol-
// agnostic — the dashboard dispatches the right per-protocol serializer
// based on `meta.path`.
export interface DumpStreamEvent {
  frame: ProtocolFrame<unknown>;
  ts: number;               // ms relative to startedAt
}

// --- Storage shape (in-process, never serialized) ---

export interface StoredDumpRequest {
  method: string;
  path: string;
  // Captured verbatim with no redaction: the dump only surfaces to the
  // owning API key's operator, who already holds the key.
  headers: Array<[string, string]>;
  body: Uint8Array;
}

export type PreparedDumpRequestBody = {
  readonly encoding: 'identity' | 'gzip';
  readonly bytes: Uint8Array;
  readonly decodedByteLength: number;
};

export interface DumpWriteRequest {
  method: string;
  path: string;
  headers: Array<[string, string]>;
  body: PreparedDumpRequestBody;
}

export type StoredDumpResponseBody =
  | { type: 'stream'; events: DumpStreamEvent[] }
  | { type: 'bytes'; body: Uint8Array }
  | { type: 'none' };

export interface StoredDumpResponse {
  status: number | null;
  headers: Array<[string, string]>;
  body: StoredDumpResponseBody;
}

export type StoredDumpRecord = {
  meta: DumpMetadata;
  request: StoredDumpRequest;
  response: StoredDumpResponse;
};

export type DumpWriteRecord = {
  meta: DumpMetadata;
  request: DumpWriteRequest;
  response: StoredDumpResponse;
};

// --- Wire shape (serialized JSON over the dashboard's control plane) ---

// `utf8` is chosen from the upstream content-type, with a UTF-8-fatal
// fallback to `base64` when a textual content-type carried non-UTF-8 bytes.
// JSON cannot carry `Uint8Array` directly, so this discriminator lives at
// the HTTP boundary and nowhere else.
export type DumpBody =
  | { encoding: 'utf8'; data: string }
  | { encoding: 'base64'; data: string };

interface DumpRequest {
  method: string;
  path: string;
  headers: Array<[string, string]>;
  body: DumpBody;
}

export type DumpResponseBody =
  | { type: 'stream'; events: DumpStreamEvent[] }
  | { type: 'bytes'; body: DumpBody }
  | { type: 'none' };

interface DumpResponse {
  status: number | null;
  headers: Array<[string, string]>;
  body: DumpResponseBody;
}

export type DumpRecord = {
  meta: DumpMetadata;
  request: DumpRequest;
  response: DumpResponse;
};
