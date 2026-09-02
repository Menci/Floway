import type { StoredOpenAIResponsesItemPayload } from './types.ts';
import { gunzipBytes, gzipBytes } from '../shared/gzip.ts';
import { getFileStore, sha256Hex } from '@floway-dev/platform';
import { decodeForgivingBase64, encodeBase64, encodeBase64url } from '@floway-dev/protocols/common';

type StoredOpenAIResponsesPayloadJson =
  | {
    version: 1;
    storage: 'inline';
    encoding: 'gzip';
    payload: string;
  }
  | {
    version: 1;
    storage: 'file';
    encoding: 'gzip';
    sha256: string;
    byteLength: number;
  };

// Caps the JSON descriptor written into D1's `payload_json` column. Compressing
// the body before this check trades a little CPU for a meaningful cut in D1
// storage on the JSON-heavy gpt-5 transcripts the gateway stores, and the
// cap pushes large tool outputs out to the file store where per-byte
// storage is dramatically cheaper than D1.
const INLINE_PAYLOAD_LIMIT_BYTES = 64 * 1024;
const OPENAI_RESPONSES_ITEMS_FILE_ROOT = 'responses-items/v2/objects/';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface PreparedStoredOpenAIResponsesPayload {
  payloadJson: string;
  file: { key: string; body: Uint8Array } | null;
}

export const prepareStoredOpenAIResponsesPayload = async (
  id: string,
  apiKeyId: string,
  payload: StoredOpenAIResponsesItemPayload,
): Promise<PreparedStoredOpenAIResponsesPayload> => {
  const rawBytes = encoder.encode(JSON.stringify(payload));
  const gzippedBytes = await gzipBytes(rawBytes);

  const inlineJson = JSON.stringify({
    version: 1,
    storage: 'inline',
    encoding: 'gzip',
    payload: encodeBase64(gzippedBytes),
  } satisfies StoredOpenAIResponsesPayloadJson);
  if (encoder.encode(inlineJson).byteLength <= INLINE_PAYLOAD_LIMIT_BYTES) {
    return { payloadJson: inlineJson, file: null };
  }

  // File body holds the gzipped payload bytes only. The descriptor in D1's
  // `payload_json` column carries version, storage discriminator, encoding,
  // sha256 and byteLength; `payload_file_key` stores the associated object key.
  // sha256/byteLength describe the file's actual bytes (gzipped) so file
  // integrity verification stays a plain hash-of-body check.
  const sha256 = await sha256Hex(gzippedBytes);
  const apiKeyHash = await sha256Hex(encoder.encode(apiKeyId));
  // Producer IDs are opaque and may contain separators or unbounded text, so
  // only their API-key-scoped digest is allowed into the object path.
  const itemScopeHash = await sha256Hex(encoder.encode(`${apiKeyId}\0${id}`));
  // The digest keeps content identity visible, while the random suffix gives
  // each attempted write a unique object key. A losing concurrent write can
  // delete its object without racing the winner for the same item.
  const key = `${OPENAI_RESPONSES_ITEMS_FILE_ROOT}${apiKeyHash}/${itemScopeHash}/${sha256}-${randomFileSuffix()}.gz`;
  const payloadJson = JSON.stringify({
    version: 1,
    storage: 'file',
    encoding: 'gzip',
    sha256,
    byteLength: gzippedBytes.byteLength,
  } satisfies StoredOpenAIResponsesPayloadJson);
  return { payloadJson, file: { key, body: gzippedBytes } };
};

export const writePreparedStoredOpenAIResponsesPayload = async (prepared: PreparedStoredOpenAIResponsesPayload): Promise<void> => {
  if (prepared.file !== null) await getFileStore().put(prepared.file.key, prepared.file.body);
};

export const parseStoredOpenAIResponsesPayload = async (
  id: string,
  raw: string,
  fileKey: string | null,
): Promise<StoredOpenAIResponsesItemPayload> => {
  const descriptor = parseDescriptor(id, raw);
  if (descriptor.storage === 'inline') {
    if (fileKey !== null) throw new Error(`Inline OpenAI Responses payload unexpectedly owns a file for id=${id}`);
    return parseInlinePayloadJson(id, await ungzipToString(decodeForgivingBase64(descriptor.payload)));
  }

  if (fileKey === null) throw new Error(`Stored OpenAI Responses payload file key missing for id=${id}`);
  const body = await getFileStore().get(fileKey);
  if (body === null) throw new Error(`Stored OpenAI Responses payload file missing for id=${id}`);
  if (body.byteLength !== descriptor.byteLength) {
    throw new Error(`Stored OpenAI Responses payload file size mismatch for id=${id}`);
  }
  const actualHash = await sha256Hex(body);
  if (actualHash !== descriptor.sha256) {
    throw new Error(`Stored OpenAI Responses payload file hash mismatch for id=${id}`);
  }

  return parseInlinePayloadJson(id, await ungzipToString(body));
};

const parseInlinePayloadJson = (id: string, json: string): StoredOpenAIResponsesItemPayload => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error(`Malformed stored OpenAI Responses payload JSON for id=${id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  return assertPayloadObject(id, parsed);
};

const parseDescriptor = (id: string, raw: string): StoredOpenAIResponsesPayloadJson => {
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
  }
  if (parsed.storage === 'file'
    && typeof parsed.sha256 === 'string'
    && typeof parsed.byteLength === 'number'
    && Number.isSafeInteger(parsed.byteLength)
    && parsed.byteLength >= 0
  ) {
    if (parsed.encoding === 'gzip') return { version: 1, storage: 'file', encoding: 'gzip', sha256: parsed.sha256, byteLength: parsed.byteLength };
  }
  throw new Error(`Invalid responses_items.payload_json for id=${id} (storage=${typeof parsed.storage === 'string' ? parsed.storage : 'unknown'}, encoding=${typeof parsed.encoding === 'string' ? parsed.encoding : 'absent'})`);
};

const assertPayloadObject = (id: string, value: unknown): StoredOpenAIResponsesItemPayload => {
  if (!isRecord(value) || !Object.hasOwn(value, 'item')) throw new Error(`Invalid stored OpenAI Responses payload for id=${id}`);
  const payload: StoredOpenAIResponsesItemPayload = { item: value.item };
  if (Object.hasOwn(value, 'private')) payload.private = value.private;
  return payload;
};

const ungzipToString = async (bytes: Uint8Array): Promise<string> =>
  decoder.decode(await gunzipBytes(bytes));

const randomFileSuffix = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return encodeBase64url(bytes);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
