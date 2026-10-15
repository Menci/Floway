import { Tag } from 'cbor-x';

import { contentHashKey, THIN_TAGS, type AssistantTurnStateFor, type ReferencePart, type TextReference, type ThinAssistantTurnFor, type ThinReference } from './assistant-turn.ts';
import type { AssistantTurnByProtocol, AssistantTurnFor } from '../assistant-turn.ts';
import { encodeSidecarValue } from '../codec.ts';
import { hashRoundTripContent } from '../replay-check.ts';

const builderBrand: unique symbol = Symbol('ReferenceBuilder');
const fieldStateBrand: unique symbol = Symbol('FieldState');
const contentStateBrand: unique symbol = Symbol('ContentState');

export type PartId = number;
type ContentId = number;

export interface ReferenceBuilder { readonly [builderBrand]: true }

export interface FieldState { readonly [fieldStateBrand]: true }

export interface ContentState { readonly [contentStateBrand]: true }

export interface FieldStates { readonly text: FieldState; readonly json: never }

export interface ContentStates { readonly text: ContentState; readonly json: never }

interface Resolution {
  readonly contentId: ContentId;
  readonly start: number;
  readonly endExclusive: number;
}

interface FieldData {
  text: string;
  readonly partIds: PartId[];
}

interface ContentData {
  readonly contentId: ContentId;
  text: string;
}

interface BuilderState {
  readonly pieces: string[];
  readonly resolutions: Map<PartId, Resolution>;
  nextContentId: number;
}

const builderStates = new WeakMap<ReferenceBuilder, BuilderState>();
const fieldStates = new WeakMap<object, FieldData>();
const contentStates = new WeakMap<object, ContentData>();

const stateOf = (builder: ReferenceBuilder): BuilderState => {
  const state = builderStates.get(builder);
  if (state === undefined) throw new Error('Unknown ReferenceBuilder handle');
  return state;
};

export const createReferenceBuilder = (): ReferenceBuilder => {
  const builder: ReferenceBuilder = { [builderBrand]: true };
  builderStates.set(builder, { pieces: [], resolutions: new Map(), nextContentId: 0 });
  return builder;
};

const fieldData = (field: FieldState): FieldData => {
  const data = fieldStates.get(field);
  if (data === undefined) throw new Error('Unknown field state');
  return data;
};

const contentData = (content: ContentState): ContentData => {
  const data = contentStates.get(content);
  if (data === undefined) throw new Error('Unknown content state');
  return data;
};

export const createFieldState = (): FieldState => {
  const field: FieldState = { [fieldStateBrand]: true };
  fieldStates.set(field, { text: '', partIds: [] });
  return field;
};

export const appendField = (builder: ReferenceBuilder, field: FieldState, text: string): PartId => {
  const state = stateOf(builder);
  const data = fieldData(field);
  const partId = state.pieces.length;
  state.pieces.push(text);
  data.text += text;
  data.partIds.push(partId);
  return partId;
};

export const createContentState = (builder: ReferenceBuilder): ContentState => {
  const state = stateOf(builder);
  const content: ContentState = { [contentStateBrand]: true };
  contentStates.set(content, { contentId: state.nextContentId++, text: '' });
  return content;
};

export const appendContent = (builder: ReferenceBuilder, content: ContentState, text: string, partIds?: readonly PartId[]): void => {
  const data = contentData(content);
  let offset = data.text.length;
  data.text += text;
  if (partIds === undefined || partIds.length === 0) return;
  const state = stateOf(builder);
  for (const partId of partIds) {
    const piece = state.pieces[partId];
    if (piece === undefined) throw new Error(`Unknown ReferenceBuilder part ${partId}`);
    if (state.resolutions.has(partId)) throw new Error(`ReferenceBuilder part ${partId} has multiple output occurrences`);
    state.resolutions.set(partId, { contentId: data.contentId, start: offset, endExclusive: offset + piece.length });
    offset += piece.length;
  }
  if (offset !== data.text.length) throw new Error('IR text and its original parts have different lengths');
};

const isFieldState = (value: unknown): value is FieldState =>
  typeof value === 'object' && value !== null && fieldStates.has(value);

const isContentState = (value: unknown): value is ContentState =>
  typeof value === 'object' && value !== null && contentStates.has(value);

const pairedChildren = function* (value: unknown, state: unknown): Generator<readonly [unknown, unknown]> {
  if (Array.isArray(state)) {
    if (!Array.isArray(value)) throw new TypeError('ReferenceBuilder state array does not match its assistant turn');
    for (let index = 0; index < state.length; index++) {
      if (!Object.hasOwn(state, index)) continue;
      yield [value[index], state[index]];
    }
    return;
  }
  if (typeof state !== 'object' || state === null) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('ReferenceBuilder state object does not match its assistant turn');
  for (const [key, childState] of Object.entries(state)) yield [Reflect.get(value, key), childState];
};

export function collectContentViews(value: unknown, contentState: ContentState): Map<ContentId, string>;
export function collectContentViews<Protocol extends keyof AssistantTurnByProtocol>(
  turn: AssistantTurnFor<Protocol>,
  contentState: AssistantTurnStateFor<Protocol, ContentStates>,
): Map<ContentId, string>;
export function collectContentViews(turn: unknown, contentState: unknown): Map<ContentId, string> {
  const views = new Map<ContentId, string>();
  const visit = (value: unknown, state: unknown): void => {
    if (isContentState(state)) {
      const data = contentData(state);
      if (typeof value === 'string' && value === data.text) views.set(data.contentId, value);
      return;
    }
    for (const [childValue, childState] of pairedChildren(value, state)) visit(childValue, childState);
  };
  visit(turn, contentState);
  return views;
}

interface ReferenceSegment {
  readonly hashIndex: number;
  readonly start: number;
  endExclusive: number;
  readonly contentLength: number;
}

interface ResolvedSegment {
  readonly contentId: ContentId;
  readonly content: string;
  readonly start: number;
  readonly endExclusive: number;
}

interface FinalizationState {
  readonly referencedContents: Uint8Array[];
  readonly hashIndexByContentId: Map<ContentId, number>;
  readonly hashIndexByDigest: Map<string, number>;
}

interface ReferenceFinalizer {
  readonly referencedContents: Uint8Array[];
  finalizeField: (original: string, field: FieldState) => Promise<string | TextReference>;
}

export const createReferenceFinalizer = async (builder: ReferenceBuilder, contentViews: ReadonlyMap<ContentId, string>): Promise<ReferenceFinalizer> => {
  const builderState = stateOf(builder);
  const state: FinalizationState = {
    referencedContents: [],
    hashIndexByContentId: new Map(),
    hashIndexByDigest: new Map(),
  };

  const hashIndex = async (contentId: ContentId, content: string): Promise<number> => {
    const existing = state.hashIndexByContentId.get(contentId);
    if (existing !== undefined) return existing;
    const digest = await hashRoundTripContent(content);
    const key = contentHashKey(digest);
    let index = state.hashIndexByDigest.get(key);
    if (index === undefined) {
      index = state.referencedContents.length;
      state.referencedContents.push(digest);
      state.hashIndexByDigest.set(key, index);
    }
    state.hashIndexByContentId.set(contentId, index);
    return index;
  };

  const finalizeField = async (original: string, field: FieldState): Promise<string | TextReference> => {
    const fieldState = fieldData(field);
    if (fieldState.partIds.length === 0 || fieldState.text !== original) return original;
    const resolved: ResolvedSegment[] = [];
    for (const partId of fieldState.partIds) {
      const piece = builderState.pieces[partId];
      const resolution = builderState.resolutions.get(partId);
      if (piece === undefined || resolution === undefined) return original;
      const content = contentViews.get(resolution.contentId);
      if (content === undefined || content.slice(resolution.start, resolution.endExclusive) !== piece) return original;
      resolved.push({ contentId: resolution.contentId, content, start: resolution.start, endExclusive: resolution.endExclusive });
    }
    const segments: ReferenceSegment[] = [];
    for (const resolution of resolved) {
      const index = await hashIndex(resolution.contentId, resolution.content);
      const previous = segments.at(-1);
      if (previous?.hashIndex === index && previous.endExclusive === resolution.start) previous.endExclusive = resolution.endExclusive;
      else segments.push({ hashIndex: index, start: resolution.start, endExclusive: resolution.endExclusive, contentLength: resolution.content.length });
    }
    const payload: ReferencePart[] = segments.map(segment => segment.start === 0 && segment.endExclusive === segment.contentLength
      ? segment.hashIndex
      : [segment.hashIndex, segment.start, segment.endExclusive]);
    return new Tag(payload, THIN_TAGS.text) as TextReference;
  };

  return { referencedContents: state.referencedContents, finalizeField };
};

interface FinalizedAssistantTurn<Turn> {
  readonly assistantTurn: Turn;
  readonly referencedContents?: Uint8Array[];
}

interface ReferenceChoice {
  readonly field: FieldState;
  readonly reference: ThinReference;
  readonly hashes: number[];
  readonly savings: number;
}

export const finalizeAssistantTurnReferences = async <Protocol extends keyof AssistantTurnByProtocol>(
  turn: AssistantTurnFor<Protocol>,
  fieldState: AssistantTurnStateFor<Protocol, FieldStates>,
  builder: ReferenceBuilder,
  contentViews: ReadonlyMap<ContentId, string>,
): Promise<FinalizedAssistantTurn<ThinAssistantTurnFor<Protocol, ThinReference>>> => {
  const finalizer = await createReferenceFinalizer(builder, contentViews);
  const minimumReferenceCost = encodeSidecarValue(new Tag([0], THIN_TAGS.text)).byteLength;
  const choices: ReferenceChoice[] = [];
  const collect = async (value: unknown, state: unknown): Promise<void> => {
    if (isFieldState(state)) {
      if (typeof value !== 'string') throw new TypeError('Text field state does not match its assistant turn');
      const original = value;
      const literalCost = encodeSidecarValue(original).byteLength;
      if (literalCost <= minimumReferenceCost) return;
      const reference = await finalizer.finalizeField(original, state);
      if (typeof reference !== 'string') {
        const savings = literalCost - encodeSidecarValue(reference).byteLength;
        if (savings > 0) choices.push({ field: state, reference, hashes: [...new Set(reference.value.map(part => Array.isArray(part) ? part[0] : part))], savings });
      }
      return;
    }
    for (const [childValue, childState] of pairedChildren(value, state)) await collect(childValue, childState);
  };
  await collect(turn, fieldState);
  if (choices.length === 0) return { assistantTurn: turn };

  const usesByHash: ReferenceChoice[][] = finalizer.referencedContents.map(() => []);
  const hashCosts = finalizer.referencedContents.map(hash => encodeSidecarValue(hash).byteLength);
  for (const choice of choices) for (const hash of choice.hashes) usesByHash[hash].push(choice);
  const selected = new Map<FieldState, ThinReference>();
  const selectedHashes = new Set<number>();
  const visited = new Set<ReferenceChoice>();
  let savings = 0;
  // A field is atomic, so a field using several hashes couples their digest costs.
  for (const first of choices) {
    if (visited.has(first)) continue;
    const group: ReferenceChoice[] = [];
    const hashes = new Set<number>();
    const pending = [first];
    let groupSavings = 0;
    for (const choice of pending) {
      if (visited.has(choice)) continue;
      visited.add(choice);
      group.push(choice);
      groupSavings += choice.savings;
      for (const hash of choice.hashes) {
        if (hashes.has(hash)) continue;
        hashes.add(hash);
        groupSavings -= hashCosts[hash];
        for (const use of usesByHash[hash]) pending.push(use);
      }
    }
    if (groupSavings <= 0) continue;
    savings += groupSavings;
    for (const choice of group) selected.set(choice.field, choice.reference);
    for (const hash of hashes) selectedHashes.add(hash);
  }

  const referencedContents: Uint8Array[] = [];
  const compactIndices: number[] = [];
  let digestCost = 0;
  for (const [index, hash] of finalizer.referencedContents.entries()) {
    if (!selectedHashes.has(index)) continue;
    compactIndices[index] = referencedContents.length;
    referencedContents.push(hash);
    digestCost += hashCosts[index];
  }
  const tableOverhead = encodeSidecarValue({ referencedContents }).byteLength - encodeSidecarValue({}).byteLength - digestCost;
  if (savings <= tableOverhead) return { assistantTurn: turn };

  // Standalone CBOR leaf costs are a size model, not a global encoding optimum.
  // Provisional indices conservatively account for integer widths before compaction.
  for (const reference of selected.values()) reference.value = reference.value.map((part): ReferencePart => Array.isArray(part)
    ? [compactIndices[part[0]], part[1], part[2]]
    : compactIndices[part]);
  const visit = (value: unknown, state: unknown): unknown => {
    if (isFieldState(state)) return selected.get(state) ?? value;
    if (Array.isArray(state)) {
      if (!Array.isArray(value)) throw new TypeError('ReferenceBuilder state array does not match its assistant turn');
      const result = value.slice();
      for (let index = 0; index < state.length; index++) {
        if (!Object.hasOwn(state, index)) continue;
        result[index] = visit(value[index], state[index]);
      }
      return result;
    }
    if (typeof state !== 'object' || state === null) return value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('ReferenceBuilder state object does not match its assistant turn');
    const result = { ...value };
    for (const [key, childState] of Object.entries(state)) Reflect.set(result, key, visit(Reflect.get(value, key), childState));
    return result;
  };
  const assistantTurn = visit(turn, fieldState) as ThinAssistantTurnFor<Protocol, ThinReference>;
  return {
    assistantTurn,
    referencedContents,
  };
};
