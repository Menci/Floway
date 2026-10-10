import { Tag } from 'cbor-x';

import type { IRProjectionResult, IRProjectedContent, IRStringProjection } from './round-trip-projection.ts';
import { cloneIRJSON, irJSON, isCompleteIRJSONObject, parseIRJSONObject } from './shared/json.ts';
import type { IRPath } from './stream.ts';
import { IATReference, IR_THIN_TAGS, type IATId, type IATOriginal, type IATRestorationFor, type IRReferencePayload, type ReplaceIATReferences, type ThinAssistantTurn } from './thin-types.ts';

export interface IATEntry<T extends IATOriginal = IATOriginal> {
  id: IATId;
  path: IRPath;
  view: string;
  original: T;
  restoration: IATRestorationFor<T>;
}

export interface IAT {
  entries: Map<IATId, IATEntry>;
  projection?: IRProjectionResult;
}

export const irUTF16Bytes = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return bytes;
};

export const hashIRContent = async (text: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', irUTF16Bytes(text) as Uint8Array<ArrayBuffer>));
export const irHashKey = (hash: Uint8Array): string => Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');

export const createIAT = (): IAT => ({ entries: new Map() });

export const registerIAT = <T extends IATOriginal>(iat: IAT, path: IRPath, view: string, original: T, restoration: IATRestorationFor<T>): IATReference<T> => {
  const id = JSON.stringify([restoration, path]) as IATId;
  const source = cloneIRJSON(original);
  iat.entries.set(id, { id, path: [...path], view, original: source, restoration });
  return new IATReference<T>(id);
};

export const updateIAT = (iat: IAT, projection: IRProjectionResult): void => {
  iat.projection = cloneIRJSON(projection);
};

interface IATSegment { text: string; start: number; end: number }

const pathKey = (path: IRPath): string => JSON.stringify(path);

const restoresOriginal = (entry: IATEntry, text: string): boolean => entry.restoration === 'text'
  ? text === entry.original
  : isCompleteIRJSONObject(text) && JSON.stringify(parseIRJSONObject(text)) === JSON.stringify(entry.original);

const projectIATEntry = (iat: IAT, entry: IATEntry): IATSegment[] | undefined => {
  if (iat.projection === undefined || entry.view.length === 0) return undefined;
  const targetTextByPath = new Map<string, IRProjectedContent['text']>(iat.projection.contents
    .filter(content => content.round_trip)
    .map(content => [pathKey(content.path), content.text]));
  const spansByStart = new Map<number, IRStringProjection[]>();
  for (const span of iat.projection.projections
    .filter(span => span.round_trip && pathKey(span.source_path) === pathKey(entry.path))
    .toSorted((a, b) => a.source_start - b.source_start)) {
    const candidates = spansByStart.get(span.source_start) ?? [];
    candidates.push(span);
    spansByStart.set(span.source_start, candidates);
  }
  interface SearchFrame { cursor: number; prefix: string; candidates: IRStringProjection[]; next: number; segment?: IATSegment }
  const stack: SearchFrame[] = [{ cursor: 0, prefix: '', candidates: spansByStart.get(0) ?? [], next: 0 }];
  const failed = new Set<string>();
  const stateKey = (cursor: number, prefix: string): string => JSON.stringify([cursor, prefix]);
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (restoresOriginal(entry, frame.prefix) && (entry.restoration === 'json' || frame.cursor === entry.view.length)) return stack.slice(1).map(part => part.segment!);
    if (entry.restoration === 'text' && frame.cursor >= entry.view.length) {
      failed.add(stateKey(frame.cursor, frame.prefix));
      stack.pop();
      continue;
    }
    if (frame.next === frame.candidates.length) {
      failed.add(stateKey(frame.cursor, frame.prefix));
      stack.pop();
      continue;
    }
    const span = frame.candidates[frame.next++];
    if (span.source_end_exclusive <= frame.cursor) continue;
    const targetText = targetTextByPath.get(pathKey(span.target_path));
    if (targetText === undefined) continue;
    const prefix = frame.prefix + targetText.slice(span.target_start, span.target_end_exclusive);
    if (failed.has(stateKey(span.source_end_exclusive, prefix))) continue;
    stack.push({
      cursor: span.source_end_exclusive,
      prefix,
      candidates: spansByStart.get(span.source_end_exclusive) ?? [],
      next: 0,
      segment: { text: targetText, start: span.target_start, end: span.target_end_exclusive },
    });
  }
  return undefined;
};

interface FinalizationState { referencedContents: Uint8Array[]; hashes: Map<string, number> }

const referenceForEntry = async (iat: IAT, entry: IATEntry, state: FinalizationState): Promise<unknown> => {
  const segments = projectIATEntry(iat, entry);
  if (segments === undefined) return cloneIRJSON(entry.original);
  const payload: IRReferencePayload = [];
  for (const segment of segments) {
    const hash = await hashIRContent(segment.text);
    const key = irHashKey(hash);
    let index = state.hashes.get(key);
    if (index === undefined) {
      index = state.referencedContents.length;
      state.hashes.set(key, index);
      state.referencedContents.push(hash);
    }
    const part = segment.start === 0 && segment.end === segment.text.length
      ? index
      : [index, segment.start, segment.end] as [number, number, number];
    const previous = payload.at(-1);
    if (Array.isArray(previous) && Array.isArray(part) && previous[0] === part[0] && previous[2] === part[1]) previous[2] = part[2];
    else payload.push(part);
  }
  return new Tag(payload, entry.restoration === 'text' ? IR_THIN_TAGS.text : IR_THIN_TAGS.json);
};

const finalizeValue = async (value: unknown, iat: IAT, state: FinalizationState): Promise<unknown> => {
  if (value instanceof IATReference) {
    const entry = iat.entries.get(value.id) as IATEntry;
    return await referenceForEntry(iat, entry, state);
  }
  if (irJSON.isRawJSON(value) || value instanceof Tag || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const child of value) result.push(await finalizeValue(child, iat, state));
    return result;
  }
  if (typeof value === 'object' && value !== null) {
    const result: [string, unknown][] = [];
    for (const [key, child] of Object.entries(value)) result.push([key, await finalizeValue(child, iat, state)]);
    return Object.fromEntries(result);
  }
  return value;
};

export interface FinalizedThinAssistantTurn<T> {
  thinAssistantTurn: T;
  referencedContents: Uint8Array[];
}

export const finalizeThinAssistantTurn = async <T extends ThinAssistantTurn<IATReference>>(
  thinAssistantTurn: T,
  iat: IAT,
): Promise<FinalizedThinAssistantTurn<ReplaceIATReferences<T>>> => {
  const state: FinalizationState = { referencedContents: [], hashes: new Map() };
  return {
    thinAssistantTurn: await finalizeValue(thinAssistantTurn, iat, state) as ReplaceIATReferences<T>,
    referencedContents: state.referencedContents,
  };
};
