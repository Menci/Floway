/**
 * KV (Key-Value) blob message handling.
 *
 * The Cursor agent asks us to store/retrieve blobs (set_blob_args / get_blob_args)
 * keyed by blob_id. When the backend stores an assistant response in a blob
 * instead of streaming it, we extract the text from the blob and surface it.
 *
 * Proto:
 *   KvServerMessage: field 1 id (uint32), field 2 get_blob_args, field 3 set_blob_args
 *   KvClientMessage: field 1 id (uint32), field 2 get_blob_result, field 3 set_blob_result
 */

import { TEXT_DECODER_FATAL, parseProtoFields } from './decoding.ts';
import { encodeUint32Field, encodeMessageField, concatBytes } from './encoding.ts';
import type { KvServerMessage, BlobAnalysis } from './types.ts';

export type { KvServerMessage };

export function parseKvServerMessage(data: Uint8Array): KvServerMessage {
  const fields = parseProtoFields(data);
  const result: KvServerMessage = { id: 0, messageType: 'unknown' };

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      result.id = field.value as number;
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      result.messageType = 'get_blob_args';
      const argsFields = parseProtoFields(field.value);
      for (const af of argsFields) {
        if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobId = af.value;
        }
      }
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      result.messageType = 'set_blob_args';
      const argsFields = parseProtoFields(field.value);
      for (const af of argsFields) {
        if (af.fieldNumber === 1 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobId = af.value;
        } else if (af.fieldNumber === 2 && af.wireType === 2 && af.value instanceof Uint8Array) {
          result.blobData = af.value;
        }
      }
    }
  }

  return result;
}

export function buildKvClientMessage(
  id: number,
  resultType: 'get_blob_result' | 'set_blob_result',
  result: Uint8Array,
): Uint8Array {
  const fieldNumber = resultType === 'get_blob_result' ? 2 : 3;
  // The oneof value is a message: GetBlobResult { blob_data = 1 } / SetBlobResult
  // { error = 1 }. `result` is the raw blob bytes (get) or empty (set/miss); wrap
  // non-empty get payloads as GetBlobResult.blob_data (field 1) so cursor reads
  // the blob instead of parsing the raw bytes as the result message and stalling.
  const inner = resultType === 'get_blob_result' && result.length > 0 ? encodeMessageField(1, result) : result;
  return concatBytes(encodeUint32Field(1, id), encodeMessageField(fieldNumber, inner));
}

/**
 * AgentClientMessage with kv_client_message (field 3).
 */
export function buildAgentClientMessageWithKv(kvClientMessage: Uint8Array): Uint8Array {
  return encodeMessageField(3, kvClientMessage);
}

export function analyzeBlobData(data: Uint8Array): BlobAnalysis {
  try {
    const text = TEXT_DECODER_FATAL.decode(data);
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      return { type: 'json', json, text };
    } catch {
      return { type: 'text', text };
    }
  } catch {
    // not valid utf-8
  }

  try {
    const fields = parseProtoFields(data);
    if (fields.length > 0 && fields.length < 100) {
      const protoFields: BlobAnalysis['protoFields'] = [];
      for (const f of fields) {
        const entry: { num: number; wire: number; size: number; text?: string } = {
          num: f.fieldNumber,
          wire: f.wireType,
          size: f.value instanceof Uint8Array ? f.value.length : 0,
        };
        if (f.wireType === 2 && f.value instanceof Uint8Array) {
          try {
            entry.text = TEXT_DECODER_FATAL.decode(f.value);
          } catch {
            // binary field
          }
        }
        protoFields.push(entry);
      }
      return { type: 'protobuf', protoFields };
    }
  } catch {
    // not protobuf
  }

  return { type: 'binary' };
}

export interface AssistantBlobContent {
  blobId: string;
  content: string;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
  type?: unknown;
  text?: unknown;
  messages?: unknown[];
}

export function extractAssistantContent(blobAnalysis: BlobAnalysis, blobKey: string): AssistantBlobContent[] {
  const results: AssistantBlobContent[] = [];

  if (blobAnalysis.type === 'json' && blobAnalysis.json) {
    const json = blobAnalysis.json as MessageLike;

    if (json.role === 'assistant') {
      const content = json.content;
      if (typeof content === 'string' && content.length > 0) {
        results.push({ blobId: blobKey, content });
      } else if (Array.isArray(content)) {
        for (const part of content as MessageLike[]) {
          if (typeof part === 'string') {
            results.push({ blobId: blobKey, content: part });
          } else if (part?.type === 'text' && typeof part?.text === 'string') {
            results.push({ blobId: blobKey, content: part.text });
          }
        }
      }
    }

    if (Array.isArray(json.messages)) {
      for (const msg of json.messages as MessageLike[]) {
        if (msg?.role === 'assistant' && typeof msg?.content === 'string') {
          results.push({ blobId: blobKey, content: msg.content });
        }
      }
    }
  } else if (blobAnalysis.type === 'protobuf' && blobAnalysis.protoFields) {
    for (const field of blobAnalysis.protoFields) {
      if (field.text && field.text.length > 50 && !field.text.startsWith('{') && !field.text.startsWith('[')) {
        results.push({ blobId: `${blobKey}:f${field.num}`, content: field.text });
      }
    }
  }

  return results;
}
