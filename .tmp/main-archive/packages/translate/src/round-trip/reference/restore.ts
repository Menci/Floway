import { ContentReference, type ReplayContent, type ContentReferenceSegment, type ReferenceableAssistantTurnFor } from './assistant-turn.ts';
import { parseJSONObject } from '../../shared/json/object.ts';
import { rawJSON } from '../../shared/json/raw-json.ts';
import type { AssistantTurnByProtocol, AssistantTurnFor } from '../assistant-turn.ts';
import { hashRoundTripContent } from '../turn-digest.ts';
import { encodeHex } from '@floway-dev/protocols/common';

export type RestoreResult<T> =
  | { ok: true; turn: T }
  | { ok: false; reason: 'missing-reference' };

type RestoreValue = { ok: true; value: unknown } | { ok: false; reason: 'missing-reference' };

const referencedText = (payload: readonly ContentReferenceSegment[], referencedContentHashes: readonly Uint8Array[] | undefined, textsByHash: ReadonlyMap<string, string>): string | undefined => {
  if (referencedContentHashes === undefined) throw new TypeError('Thin reference requires referenced contents');
  const text: string[] = [];
  for (const part of payload) {
    const index = Array.isArray(part) ? part[0] : part;
    const hash = referencedContentHashes[index];
    if (hash === undefined) throw new RangeError(`Referenced content hash index is out of bounds: ${index}`);
    const source = textsByHash.get(encodeHex(hash));
    if (source === undefined) return undefined;
    text.push(Array.isArray(part) ? source.slice(part[1], part[2]) : source);
  }
  return text.join('');
};

const restoreValue = (value: unknown, referencedContentHashes: readonly Uint8Array[] | undefined, textsByHash: ReadonlyMap<string, string>): RestoreValue => {
  if (rawJSON.isRawJSON(value) || value instanceof Uint8Array) return { ok: true, value };
  if (value instanceof ContentReference) {
    const text = referencedText(value.parts, referencedContentHashes, textsByHash);
    if (text === undefined) return { ok: false, reason: 'missing-reference' };
    return { ok: true, value: value.kind === 'text' ? text : parseJSONObject(text) };
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const resolved = restoreValue(child, referencedContentHashes, textsByHash);
      if (!resolved.ok) return resolved;
      if (resolved.value !== child) Reflect.set(value, key, resolved.value);
    }
  }
  return { ok: true, value };
};

/** Consumes the exclusively owned turn decoded by the sidecar codec. */
export const restoreAssistantTurn = async <Protocol extends keyof AssistantTurnByProtocol>(
  _protocol: Protocol,
  candidates: readonly ReplayContent[],
  targetTurn: ReferenceableAssistantTurnFor<Protocol, ContentReference>,
  referencedContentHashes?: readonly Uint8Array[],
): Promise<RestoreResult<AssistantTurnFor<Protocol>>> => {
  const textsByHash = new Map<string, string>();
  if (referencedContentHashes !== undefined) {
    for (const candidate of candidates) {
      const text = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
      if (text === undefined) throw new TypeError('Replay candidate is not JSON-serializable');
      textsByHash.set(encodeHex(await hashRoundTripContent(text)), text);
    }
  }
  const result = restoreValue(targetTurn, referencedContentHashes, textsByHash);
  return result.ok
    ? { ok: true, turn: result.value as AssistantTurnFor<Protocol> }
    : result;
};
