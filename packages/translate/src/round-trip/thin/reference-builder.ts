import { ThinReference, type AssistantTurnStateFor, type ReferencePart, type ThinAssistantTurnFor } from './assistant-turn.ts';
import type { IRJSONObject } from '../../ir/types.ts';
import { parseJSONObject, requireJSONObject } from '../../shared/json/object.ts';
import type { AssistantTurnByProtocol, AssistantTurnFor } from '../assistant-turn.ts';
import { hashRoundTripContent } from '../replay-check.ts';
import type { CanonicalTextView } from '../text-parts.ts';
import { encodeHex } from '@floway-dev/protocols/common';

const stateKind: unique symbol = Symbol('ReferenceState');

export type PartId = number;
type ContentId = number;
type Restoration = 'text' | 'json';

export interface ReferenceBuilder {
  readonly pieces: string[];
  readonly resolutions: Map<PartId, Resolution>;
  nextContentId: number;
}

type OriginalFor<Kind extends Restoration> = Kind extends 'text' ? string : IRJSONObject;

export interface FieldState<Kind extends Restoration = Restoration> {
  readonly [stateKind]: 'field';
  readonly restoration: Kind;
  text: string;
  readonly partIds: PartId[];
}

export interface ContentState<Kind extends Restoration = Restoration> {
  readonly [stateKind]: 'content';
  readonly restoration: Kind;
  readonly contentId: ContentId;
  text: string;
}

export interface FieldStates {
  readonly text: FieldState<'text'>;
  readonly json: FieldState<'json'>;
}

export interface ContentStates {
  readonly text: ContentState<'text'>;
  readonly json: ContentState<'json'>;
}

interface Resolution {
  readonly contentId: ContentId;
  readonly start: number;
  readonly endExclusive: number;
}

export const createReferenceBuilder = (): ReferenceBuilder => ({ pieces: [], resolutions: new Map(), nextContentId: 0 });

export const createFieldState = <Kind extends Restoration>(restoration: Kind): FieldState<Kind> => ({
  [stateKind]: 'field', restoration, text: '', partIds: [],
});

export const appendField = (builder: ReferenceBuilder, field: FieldState, text: string): PartId => {
  const partId = builder.pieces.length;
  builder.pieces.push(text);
  field.text += text;
  field.partIds.push(partId);
  return partId;
};

export const createContentState = <Kind extends Restoration>(builder: ReferenceBuilder, restoration: Kind): ContentState<Kind> => ({
  [stateKind]: 'content', restoration, contentId: builder.nextContentId++, text: '',
});

export const appendContent = (builder: ReferenceBuilder, content: ContentState, text: string, partIds?: readonly PartId[]): void => {
  let offset = content.text.length;
  content.text += text;
  if (partIds === undefined || partIds.length === 0) return;
  for (const partId of partIds) {
    const piece = builder.pieces[partId];
    if (piece === undefined) throw new Error(`Unknown ReferenceBuilder part ${partId}`);
    if (builder.resolutions.has(partId)) throw new Error(`ReferenceBuilder part ${partId} has multiple output occurrences`);
    builder.resolutions.set(partId, { contentId: content.contentId, start: offset, endExclusive: offset + piece.length });
    offset += piece.length;
  }
  if (offset !== content.text.length) throw new Error('IR text and its original parts have different lengths');
};

const isFieldState = (value: unknown): value is FieldState =>
  typeof value === 'object' && value !== null && stateKind in value && value[stateKind] === 'field';

const isContentState = (value: unknown): value is ContentState =>
  typeof value === 'object' && value !== null && stateKind in value && value[stateKind] === 'content';

const textView = (kind: Restoration, value: unknown): string | undefined => {
  if (kind === 'text') return typeof value === 'string' ? value : undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return JSON.stringify(value);
};

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

export function collectContentViews(value: unknown, contentState: ContentState): Map<ContentId, CanonicalTextView>;
export function collectContentViews<Protocol extends keyof AssistantTurnByProtocol>(
  turn: AssistantTurnFor<Protocol>,
  contentState: AssistantTurnStateFor<Protocol, ContentStates>,
  textViews?: ReadonlyMap<object, CanonicalTextView>,
): Map<ContentId, CanonicalTextView>;
export function collectContentViews(turn: unknown, contentState: unknown, textViews?: ReadonlyMap<object, CanonicalTextView>): Map<ContentId, CanonicalTextView> {
  const views = new Map<ContentId, CanonicalTextView>();
  const visit = (value: unknown, state: unknown, canonical?: CanonicalTextView): void => {
    if (isContentState(state)) {
      const view = textView(state.restoration, value);
      if (view === state.text) views.set(state.contentId, canonical ?? { text: view, offset: 0 });
      return;
    }
    const view = typeof value === 'object' && value !== null ? textViews?.get(value) : undefined;
    for (const [childValue, childState] of pairedChildren(value, state)) {
      visit(childValue, childState, view !== undefined && isContentState(childState) && childState.restoration === 'text' ? view : undefined);
    }
  };
  visit(turn, contentState);
  return views;
}

const restoresOriginal = <Kind extends Restoration>(field: FieldState<Kind>, original: OriginalFor<Kind>): boolean => {
  if (field.restoration === 'text') return typeof original === 'string' && field.text === original;
  if (typeof original !== 'object' || original === null || Array.isArray(original)) return false;
  try {
    return JSON.stringify(parseJSONObject(field.text)) === JSON.stringify(original);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
};

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

interface ReferenceFinalizer {
  readonly referencedContents: Uint8Array[];
  finalizeField: <Kind extends Restoration>(
    original: OriginalFor<Kind>,
    field: FieldState<Kind>,
  ) => Promise<OriginalFor<Kind> | ThinReference<Kind>>;
}

export const createReferenceFinalizer = (builder: ReferenceBuilder, contentViews: ReadonlyMap<ContentId, CanonicalTextView>): ReferenceFinalizer => {
  const referencedContents: Uint8Array[] = [];
  const hashIndexByContentId = new Map<ContentId, number>();
  const hashIndexByContent = new Map<string, number>();
  const hashIndexByDigest = new Map<string, number>();

  const hashIndex = async (contentId: ContentId, content: string): Promise<number> => {
    const resolved = hashIndexByContentId.get(contentId);
    if (resolved !== undefined) return resolved;
    const existing = hashIndexByContent.get(content);
    if (existing !== undefined) {
      hashIndexByContentId.set(contentId, existing);
      return existing;
    }
    const digest = await hashRoundTripContent(content);
    const key = encodeHex(digest);
    let index = hashIndexByDigest.get(key);
    if (index === undefined) {
      index = referencedContents.length;
      referencedContents.push(digest);
      hashIndexByDigest.set(key, index);
    }
    hashIndexByContent.set(content, index);
    hashIndexByContentId.set(contentId, index);
    return index;
  };

  const finalizeField = async <Kind extends Restoration>(
    original: OriginalFor<Kind>,
    field: FieldState<Kind>,
  ): Promise<OriginalFor<Kind> | ThinReference<Kind>> => {
    if (field.partIds.length === 0 || !restoresOriginal(field, original)) return original;
    const resolved: ResolvedSegment[] = [];
    for (const partId of field.partIds) {
      const piece = builder.pieces[partId];
      const resolution = builder.resolutions.get(partId);
      if (piece === undefined || resolution === undefined) return original;
      const view = contentViews.get(resolution.contentId);
      if (view === undefined) return original;
      const start = view.offset + resolution.start;
      const endExclusive = view.offset + resolution.endExclusive;
      if (view.text.slice(start, endExclusive) !== piece) return original;
      resolved.push({ contentId: resolution.contentId, content: view.text, start, endExclusive });
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
    return new ThinReference(field.restoration, payload);
  };

  return { referencedContents, finalizeField };
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

// Deliberately coarse budgets keep selection independent of the injected codec.
// Shared hashes are charged once; indices and ranges use fixed generous costs.
const REFERENCE_OVERHEAD = 8;
const HASH_BUDGET = 16;
const HASH_TABLE_BUDGET = 32;

const referenceBudget = (reference: ThinReference): number => REFERENCE_OVERHEAD
  + reference.parts.reduce<number>((cost, part) => cost + (typeof part === 'number' ? 4 : 16), 0);

export const finalizeAssistantTurnReferences = async <Protocol extends keyof AssistantTurnByProtocol>(
  turn: AssistantTurnFor<Protocol>,
  fieldState: AssistantTurnStateFor<Protocol, FieldStates>,
  builder: ReferenceBuilder,
  contentViews: ReadonlyMap<ContentId, CanonicalTextView>,
): Promise<FinalizedAssistantTurn<ThinAssistantTurnFor<Protocol, ThinReference>>> => {
  const finalizer = createReferenceFinalizer(builder, contentViews);
  const minimumReferenceBudget = REFERENCE_OVERHEAD + 4;
  const choices: ReferenceChoice[] = [];
  const collect = async (value: unknown, state: unknown): Promise<void> => {
    if (isFieldState(state)) {
      let original: string | IRJSONObject;
      if (state.restoration === 'text') {
        if (typeof value !== 'string') throw new TypeError('Text field state does not match its assistant turn');
        original = value;
      } else original = requireJSONObject(value);
      const literalBudget = typeof original === 'string' ? original.length : JSON.stringify(original).length;
      if (literalBudget <= minimumReferenceBudget) return;
      const reference = await finalizer.finalizeField(original, state);
      if (reference instanceof ThinReference) {
        const savings = literalBudget - referenceBudget(reference);
        if (savings > 0) choices.push({ field: state, reference, hashes: [...new Set(reference.parts.map(part => Array.isArray(part) ? part[0] : part))], savings });
      }
      return;
    }
    for (const [childValue, childState] of pairedChildren(value, state)) await collect(childValue, childState);
  };
  await collect(turn, fieldState);
  if (choices.length === 0) return { assistantTurn: turn };

  const savingsByHash = finalizer.referencedContents.map(() => 0);
  for (const choice of choices) for (const hash of choice.hashes) savingsByHash[hash] += choice.savings / choice.hashes.length;
  const selected = new Map<FieldState, ThinReference>();
  const selectedHashes = new Set<number>();
  let savings = 0;
  for (const choice of choices) {
    if (choice.hashes.some(hash => savingsByHash[hash] <= HASH_BUDGET)) continue;
    selected.set(choice.field, choice.reference);
    savings += choice.savings;
    for (const hash of choice.hashes) selectedHashes.add(hash);
  }
  // Rejected atomic fields may have contributed to a surviving hash's estimate.
  // Check the selected set again so those contributions cannot fund its table.
  if (savings <= HASH_TABLE_BUDGET + selectedHashes.size * HASH_BUDGET) return { assistantTurn: turn };

  const referencedContents: Uint8Array[] = [];
  const compactIndices: number[] = [];
  for (const [index, hash] of finalizer.referencedContents.entries()) {
    if (!selectedHashes.has(index)) continue;
    compactIndices[index] = referencedContents.length;
    referencedContents.push(hash);
  }

  for (const reference of selected.values()) reference.parts = reference.parts.map((part): ReferencePart => Array.isArray(part)
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
