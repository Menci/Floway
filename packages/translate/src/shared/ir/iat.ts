import { Tag } from 'cbor-x';

import type { IRProjectionResult, IRProjectedContent } from './round-trip-projection.ts';
import { cloneIRJSON, irJSON, isCompleteIRJSONObject, parseIRJSONObject } from './shared/json.ts';
import type { IRPath } from './stream.ts';
import { IATReference, IR_THIN_TAGS, type IATId, type IATOriginal, type IATRestorationFor, type IRReferencePayload, type ReplaceIATReferences, type ThinAssistantTurn } from './thin-types.ts';

export interface IATEntry<T extends IATOriginal = IATOriginal> {
  id: IATId;
  nativePath: IRPath;
  sources: IATSource[];
  view: string;
  original: T;
  restoration: IATRestorationFor<T>;
}

export interface IATSource {
  path: IRPath;
  sourceStart: number;
  sourceEndExclusive: number;
  viewStart: number;
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

export const registerIAT = <T extends IATOriginal>(iat: IAT, nativePath: IRPath, sources: readonly IATSource[], view: string, original: T, restoration: IATRestorationFor<T>): IATReference<T> => {
  const id = JSON.stringify([restoration, nativePath]) as IATId;
  iat.entries.set(id, { id, nativePath: [...nativePath], sources: sources.map(source => ({ ...source, path: [...source.path] })), view, original: cloneIRJSON(original), restoration });
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
  const spansByStart = new Map<number, (IATSegment & { viewEnd: number })[]>();
  for (const source of entry.sources) {
    for (const span of iat.projection.projections) {
      if (!span.round_trip || pathKey(span.source_path) !== pathKey(source.path)) continue;
      const sourceStart = Math.max(source.sourceStart, span.source_start);
      const sourceEnd = Math.min(source.sourceEndExclusive, span.source_end_exclusive);
      if (sourceEnd <= sourceStart) continue;
      const targetText = targetTextByPath.get(pathKey(span.target_path));
      if (targetText === undefined) continue;
      const fullSpan = sourceStart === span.source_start && sourceEnd === span.source_end_exclusive;
      if (!fullSpan && span.target_end_exclusive - span.target_start !== span.source_end_exclusive - span.source_start) continue;
      const viewStart = source.viewStart + sourceStart - source.sourceStart;
      const viewEnd = viewStart + sourceEnd - sourceStart;
      const candidates = spansByStart.get(viewStart) ?? [];
      candidates.push({
        text: targetText,
        start: fullSpan ? span.target_start : span.target_start + sourceStart - span.source_start,
        end: fullSpan ? span.target_end_exclusive : span.target_start + sourceEnd - span.source_start,
        viewEnd,
      });
      spansByStart.set(viewStart, candidates);
    }
  }
  interface SearchFrame { cursor: number; prefix: string; candidates: (IATSegment & { viewEnd: number })[]; next: number; segment?: IATSegment }
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
    const segment = frame.candidates[frame.next++];
    const prefix = frame.prefix + segment.text.slice(segment.start, segment.end);
    if (failed.has(stateKey(segment.viewEnd, prefix))) continue;
    stack.push({
      cursor: segment.viewEnd,
      prefix,
      candidates: spansByStart.get(segment.viewEnd) ?? [],
      next: 0,
      segment,
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
