import { Tag } from 'cbor-x';

import { hashIRContent, irHashKey } from './iat.ts';
import { irJSON, parseIRJSONObject } from './shared/json.ts';
import { IR_THIN_TAGS, type IRReplayCandidate, type IRReferencePayload, type RemoveThinReferences, type ThinAssistantTurn, type ThinReference } from './thin-types.ts';

export type ThinHydrationResult<T> =
  | { ok: true; turn: T }
  | { ok: false; reason: 'missing-reference' };

type HydrationValue = { ok: true; value: unknown } | { ok: false; reason: 'missing-reference' };

const replayCandidateText = (candidate: IRReplayCandidate): string => typeof candidate === 'string' ? candidate : JSON.stringify(candidate) as string;

const referencedText = (payload: unknown, referencedContents: readonly Uint8Array[], textsByHash: ReadonlyMap<string, string>): string | undefined => {
  const text: string[] = [];
  for (const part of payload as IRReferencePayload) {
    const index = Array.isArray(part) ? part[0] : part;
    const hash = referencedContents[index];
    if (hash === undefined) return undefined;
    const source = textsByHash.get(irHashKey(hash));
    if (source === undefined) return undefined;
    text.push(Array.isArray(part) ? source.slice(part[1], part[2]) : source);
  }
  return text.join('');
};

const hydrateValue = (value: unknown, referencedContents: readonly Uint8Array[], textsByHash: ReadonlyMap<string, string>): HydrationValue => {
  if (irJSON.isRawJSON(value) || value instanceof Uint8Array) return { ok: true, value };
  if (value instanceof Tag) {
    if (value.tag === IR_THIN_TAGS.text || value.tag === IR_THIN_TAGS.json) {
      const text = referencedText(value.value, referencedContents, textsByHash);
      if (text === undefined) return { ok: false, reason: 'missing-reference' };
      return { ok: true, value: value.tag === IR_THIN_TAGS.text ? text : parseIRJSONObject(text) };
    }
    return { ok: true, value };
  }
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

export const hydrate = async <T extends ThinAssistantTurn<ThinReference>>(
  candidates: readonly IRReplayCandidate[],
  thinAssistantTurn: T,
  referencedContents: readonly Uint8Array[],
): Promise<ThinHydrationResult<RemoveThinReferences<T>>> => {
  const textsByHash = new Map<string, string>();
  for (const candidate of candidates) {
    const text = replayCandidateText(candidate);
    textsByHash.set(irHashKey(await hashIRContent(text)), text);
  }
  const result = hydrateValue(thinAssistantTurn, referencedContents, textsByHash);
  return result.ok
    ? { ok: true, turn: result.value as RemoveThinReferences<T> }
    : result;
};
