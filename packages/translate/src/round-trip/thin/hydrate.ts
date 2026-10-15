import { Tag } from 'cbor-x';

import { contentHashKey, THIN_TAGS, type ReplayCandidate, type ReferencePart, type ThinAssistantTurnFor, type ThinReference } from './assistant-turn.ts';
import { parseJSONObject } from '../../shared/json/object.ts';
import { rawJSON } from '../../shared/json/raw-json.ts';
import type { AssistantTurnByProtocol, AssistantTurnFor } from '../assistant-turn.ts';
import { hashRoundTripContent } from '../replay-check.ts';

export type HydrationResult<T> =
  | { ok: true; turn: T }
  | { ok: false; reason: 'missing-reference' };

type HydrationValue = { ok: true; value: unknown } | { ok: false; reason: 'missing-reference' };

const replayCandidateText = (candidate: ReplayCandidate): string => {
  if (typeof candidate === 'string') return candidate;
  const text = JSON.stringify(candidate);
  if (text === undefined) throw new TypeError('Replay candidate is not JSON-serializable');
  return text;
};

const referencedText = (payload: readonly ReferencePart[], referencedContents: readonly Uint8Array[] | undefined, textsByHash: ReadonlyMap<string, string>): string | undefined => {
  if (referencedContents === undefined) throw new TypeError('Thin reference requires referenced contents');
  const text: string[] = [];
  for (const part of payload) {
    const index = Array.isArray(part) ? part[0] : part;
    const hash = referencedContents[index];
    if (hash === undefined) throw new RangeError(`Referenced content hash index is out of bounds: ${index}`);
    const source = textsByHash.get(contentHashKey(hash));
    if (source === undefined) return undefined;
    text.push(Array.isArray(part) ? source.slice(part[1], part[2]) : source);
  }
  return text.join('');
};

const isThinReference = (value: unknown): value is ThinReference =>
  value instanceof Tag && (value.tag === THIN_TAGS.text || value.tag === THIN_TAGS.json);

const hydrateValue = (value: unknown, referencedContents: readonly Uint8Array[] | undefined, textsByHash: ReadonlyMap<string, string>): HydrationValue => {
  if (rawJSON.isRawJSON(value) || value instanceof Uint8Array) return { ok: true, value };
  if (isThinReference(value)) {
    const text = referencedText(value.value, referencedContents, textsByHash);
    if (text === undefined) return { ok: false, reason: 'missing-reference' };
    return { ok: true, value: value.tag === THIN_TAGS.text ? text : parseJSONObject(text) };
  }
  if (value instanceof Tag) return { ok: true, value };
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const child of value) {
      const hydrated = hydrateValue(child, referencedContents, textsByHash);
      if (!hydrated.ok) return hydrated;
      result.push(hydrated.value);
    }
    return { ok: true, value: result };
  }
  if (typeof value === 'object' && value !== null) {
    const result: [string, unknown][] = [];
    for (const [key, child] of Object.entries(value)) {
      const hydrated = hydrateValue(child, referencedContents, textsByHash);
      if (!hydrated.ok) return hydrated;
      result.push([key, hydrated.value]);
    }
    return { ok: true, value: Object.fromEntries(result) };
  }
  return { ok: true, value };
};

export const hydrateAssistantTurn = async <Protocol extends keyof AssistantTurnByProtocol>(
  _protocol: Protocol,
  candidates: readonly ReplayCandidate[],
  assistantTurn: ThinAssistantTurnFor<Protocol, ThinReference>,
  referencedContents?: readonly Uint8Array[],
): Promise<HydrationResult<AssistantTurnFor<Protocol>>> => {
  const textsByHash = new Map<string, string>();
  if (referencedContents !== undefined) {
    for (const candidate of candidates) {
      const text = replayCandidateText(candidate);
      textsByHash.set(contentHashKey(await hashRoundTripContent(text)), text);
    }
  }
  const result = hydrateValue(assistantTurn, referencedContents, textsByHash);
  return result.ok
    ? { ok: true, turn: result.value as AssistantTurnFor<Protocol> }
    : result;
};
