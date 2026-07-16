import type { StoredResponsesItemPayload } from './types.ts';
import { getFileProvider, sha256Hex } from '@floway-dev/platform';

// Encoding-less variants remain readable because migration 0058 preserves
// existing payload descriptors and files instead of rewriting their bodies.
type StoredResponsesPayloadJson =
  | {
    version: 1;
    storage: 'inline';
    payload: StoredResponsesItemPayload;
  }
  | {
    version: 1;
    storage: 'inline';
    encoding: 'gzip';
    payload: string;
  }
  | {
    version: 1;
    storage: 'file';
    key: string;
    sha256: string;
    byteLength: number;
  }
  | {
    version: 1;
    storage: 'file';
    encoding: 'gzip';
    key: string;
    sha256: string;
    byteLength: number;
  };

// Caps the JSON descriptor written into D1's `payload_json` column. Compressing
// the body before this check trades a little CPU for a meaningful cut in D1
// storage on the JSON-heavy gpt-5 transcripts the gateway stores, and the
// cap pushes large tool outputs out to the file provider where per-byte
// storage is dramatically cheaper than D1.
const INLINE_PAYLOAD_LIMIT_BYTES = 64 * 1024;
// Shared refreshable horizon for item/snapshot deletion and spilled-file
// expiry buckets. Snapshot commits refresh every referenced item's timestamp.
export const RESPONSES_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Root under which every stored-payload file lives, regardless of expiry hour.
// The replace path deletes this whole tree alongside the D1 rows it clears.
const RESPONSES_ITEMS_FILE_ROOT = 'responses-items/v1/expires/';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const serializeStoredResponsesPayload = async (
  id: string,
  apiKeyId: string,
  createdAt: number,
  payload: StoredResponsesItemPayload,
): Promise<string> => {
  const rawBytes = encoder.encode(JSON.stringify(payload));
  const gzippedBytes = await gzipBytes(rawBytes);

  const inlineJson = JSON.stringify({
    version: 1,
    storage: 'inline',
    encoding: 'gzip',
    payload: bytesToBase64(gzippedBytes),
  } satisfies StoredResponsesPayloadJson);
  if (encoder.encode(inlineJson).byteLength <= INLINE_PAYLOAD_LIMIT_BYTES) return inlineJson;

  // File body holds the gzipped payload bytes only. The descriptor in D1's
  // `payload_json` column carries version, storage discriminator, encoding,
  // key, sha256, and byteLength; the body itself does not repeat them.
  // sha256/byteLength describe the file's actual bytes (gzipped) so file
  // integrity verification stays a plain hash-of-body check.
  const sha256 = await sha256Hex(gzippedBytes);
  const expiresAt = createdAt + RESPONSES_STATE_TTL_MS;
  const apiKeyHashPrefix = (await sha256Hex(encoder.encode(apiKeyId))).slice(0, 16);
  // The digest keeps integrity/content identity visible, while the nonce gives
  // each pre-SQL write exclusive cleanup ownership. A losing concurrent write
  // can then delete its object without racing a later winner that stored the
  // same item bytes under the same expiry bucket.
  const key = `${responsesItemPayloadExpiryBucketPrefix(expiresAt)}${apiKeyHashPrefix}/${id}/${sha256}-${randomFileNonce()}.gz`;
  await getFileProvider().put(key, gzippedBytes);
  return JSON.stringify({
    version: 1,
    storage: 'file',
    encoding: 'gzip',
    key,
    sha256,
    byteLength: gzippedBytes.byteLength,
  } satisfies StoredResponsesPayloadJson);
};

export const parseStoredResponsesPayload = async (
  id: string,
  raw: string,
): Promise<StoredResponsesItemPayload> => {
  const descriptor = parseDescriptor(id, raw);
  if (descriptor.storage === 'inline') {
    return 'encoding' in descriptor
      ? parseInlinePayloadJson(id, await ungzipToString(base64ToBytes(descriptor.payload)))
      : descriptor.payload;
  }

  const body = await getFileProvider().get(descriptor.key);
  if (body === null) throw new Error(`Stored Responses payload file missing for id=${id}`);
  if (body.byteLength !== descriptor.byteLength) {
    throw new Error(`Stored Responses payload file size mismatch for id=${id}`);
  }
  const actualHash = await sha256Hex(body);
  if (actualHash !== descriptor.sha256) {
    throw new Error(`Stored Responses payload file hash mismatch for id=${id}`);
  }

  return parseInlinePayloadJson(id, 'encoding' in descriptor ? await ungzipToString(body) : decoder.decode(body));
};

export const storedResponsesPayloadFileKey = (id: string, raw: string): string | null => {
  const descriptor = parseDescriptor(id, raw);
  return descriptor.storage === 'file' ? descriptor.key : null;
};

const parseInlinePayloadJson = (id: string, json: string): StoredResponsesItemPayload => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error(`Malformed stored Responses payload JSON for id=${id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  return assertPayloadObject(id, parsed);
};

const parseDescriptor = (id: string, raw: string): StoredResponsesPayloadJson => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Malformed responses_items.payload_json JSON for id=${id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }

  if (!isRecord(parsed) || parsed.version !== 1) throw new Error(`Invalid responses_items.payload_json for id=${id}`);
  if (parsed.storage === 'inline') {
    if (parsed.encoding === 'gzip' && typeof parsed.payload === 'string') {
      return { version: 1, storage: 'inline', encoding: 'gzip', payload: parsed.payload };
    }
    if (parsed.encoding === undefined) {
      return { version: 1, storage: 'inline', payload: assertPayloadObject(id, parsed.payload) };
    }
  }
  if (parsed.storage === 'file'
    && typeof parsed.key === 'string'
    && typeof parsed.sha256 === 'string'
    && typeof parsed.byteLength === 'number'
    && Number.isSafeInteger(parsed.byteLength)
    && parsed.byteLength >= 0
  ) {
    if (parsed.encoding === 'gzip') return { version: 1, storage: 'file', encoding: 'gzip', key: parsed.key, sha256: parsed.sha256, byteLength: parsed.byteLength };
    if (parsed.encoding === undefined) return { version: 1, storage: 'file', key: parsed.key, sha256: parsed.sha256, byteLength: parsed.byteLength };
  }
  throw new Error(`Invalid responses_items.payload_json for id=${id} (storage=${typeof parsed.storage === 'string' ? parsed.storage : 'unknown'}, encoding=${typeof parsed.encoding === 'string' ? parsed.encoding : 'absent'})`);
};

const assertPayloadObject = (id: string, value: unknown): StoredResponsesItemPayload => {
  if (!isRecord(value) || !Object.hasOwn(value, 'item')) throw new Error(`Invalid stored Responses payload for id=${id}`);
  const payload: StoredResponsesItemPayload = { item: value.item };
  if (Object.hasOwn(value, 'private')) payload.private = value.private;
  return payload;
};

// Copying through `new Uint8Array(bytes)` gives Blob a concrete
// ArrayBuffer-backed view regardless of the caller's ArrayBufferLike type
// parameter; the cast-free form fails strict-mode BufferSource on slices and
// SharedArrayBuffer-backed inputs (same pattern as sha256.ts).
const gzipBytes = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const ungzipToString = async (bytes: Uint8Array): Promise<string> => {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return decoder.decode(await new Response(stream).arrayBuffer());
};

// btoa/atob operate on latin1; using fromCharCode in 32 KB chunks avoids the
// argument-count blow-up large payloads would otherwise hit.
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const randomFileNonce = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

// Files live under their expiry hour. A bucket whose hour is strictly before
// the current hour is fully past its TTL, so the sweep enumerates the existing
// bucket prefixes under the expiry root and deletes every expired one. Bucket
// prefixes use UTC YYYY/MM/DD/HH, so lexical order matches chronological order.
// This is resilient to missed cron runs: a skipped hour is revisited on the
// next run rather than leaking into R2.
export const sweepExpiredResponsesItemPayloadFiles = async (now: number): Promise<void> => {
  const currentHourPrefix = responsesItemPayloadExpiryBucketPrefix(startOfUtcHour(now));
  const provider = getFileProvider();
  const keys = await provider.listKeys(RESPONSES_ITEMS_FILE_ROOT);
  const expiredBuckets = new Set<string>();
  for (const key of keys) {
    const pathParts = key.slice(RESPONSES_ITEMS_FILE_ROOT.length).split('/');
    if (pathParts.length < 4) continue;
    const bucket = `${RESPONSES_ITEMS_FILE_ROOT}${pathParts.slice(0, 4).join('/')}/`;
    if (bucket < currentHourPrefix) expiredBuckets.add(bucket);
  }
  for (const bucket of expiredBuckets) await provider.deletePrefix(bucket);
};

// Drop every spilled payload file. Paired with a `deleteAll` over the
// responses_items rows so a full replace/clear does not orphan R2 objects.
export const deleteAllResponsesItemPayloadFiles = async (): Promise<void> => {
  await getFileProvider().deletePrefix(RESPONSES_ITEMS_FILE_ROOT);
};

export const responsesItemPayloadExpiryBucketPrefix = (hourTimestamp: number): string => {
  const date = new Date(hourTimestamp);
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  return `${RESPONSES_ITEMS_FILE_ROOT}${yyyy}/${mm}/${dd}/${hh}/`;
};

export const startOfUtcHour = (timestamp: number): number => Math.floor(timestamp / HOUR_MS) * HOUR_MS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
