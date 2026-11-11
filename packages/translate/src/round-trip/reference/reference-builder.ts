import { type InputAssistantTurnStateFor } from './assistant-turn-types.ts';
import { ContentReference, type ContentReferenceSegment } from './types.ts';
import type { IRJSONObject } from '../../ir/common/json.ts';
import { parseJSONObject } from '../../shared/json/object.ts';
import { hashRoundTripContent } from '../hash.ts';
import type { InputAssistantTurnByProtocol, InputAssistantTurnFor } from '../input-assistant-turn.ts';
import type { TextPlacement, TextPlacementIndex } from '../text-groups.ts';
import { encodeHex } from '@floway-dev/protocols/common';

const fieldStatePhase: unique symbol = Symbol('ReferenceFieldStatePhase');

export type TextFragmentId = number;
export type EmittedFieldId = number;
type ReferenceKind = 'text' | 'json';

export interface ReferenceBuilder {
  readonly fragments: string[];
  readonly fragmentPlacements: Map<TextFragmentId, FragmentPlacement>;
  nextEmittedFieldId: number;
}

type OriginalFor<Kind extends ReferenceKind> = Kind extends 'text' ? string : IRJSONObject;

export interface ReadFieldState<Kind extends ReferenceKind = ReferenceKind> {
  readonly [fieldStatePhase]: 'read';
  readonly kind: Kind;
  valid: boolean;
  text: string;
  readonly textFragmentIds: TextFragmentId[];
}

export interface EmittedFieldState<Kind extends ReferenceKind = ReferenceKind> {
  readonly [fieldStatePhase]: 'emitted';
  readonly kind: Kind;
  readonly emittedFieldId: EmittedFieldId;
  text: string;
}

export interface ReadFieldStates {
  readonly text: ReadFieldState<'text'>;
  readonly json: ReadFieldState<'json'>;
}

export interface EmittedFieldStates {
  readonly text: EmittedFieldState<'text'>;
  readonly json: EmittedFieldState<'json'>;
}

interface FragmentPlacement {
  readonly emittedFieldId: EmittedFieldId;
  readonly start: number;
  readonly endExclusive: number;
}

export const createReferenceBuilder = (): ReferenceBuilder => ({ fragments: [], fragmentPlacements: new Map(), nextEmittedFieldId: 0 });

export const createReadFieldState = <Kind extends ReferenceKind>(kind: Kind): ReadFieldState<Kind> => ({
  [fieldStatePhase]: 'read', kind, valid: true, text: '', textFragmentIds: [],
});

export const appendReadField = (builder: ReferenceBuilder, field: ReadFieldState, text: string): TextFragmentId => {
  if (!field.valid) throw new Error('Cannot append provenance to an invalid field');
  const fragmentId = builder.fragments.length;
  builder.fragments.push(text);
  field.text += text;
  field.textFragmentIds.push(fragmentId);
  return fragmentId;
};

export const invalidateReadField = (field: ReadFieldState): void => { field.valid = false; };

export const createEmittedFieldState = <Kind extends ReferenceKind>(builder: ReferenceBuilder, kind: Kind): EmittedFieldState<Kind> => ({
  [fieldStatePhase]: 'emitted', kind, emittedFieldId: builder.nextEmittedFieldId++, text: '',
});

export const appendEmittedField = (builder: ReferenceBuilder, content: EmittedFieldState, text: string, textFragmentIds?: readonly TextFragmentId[]): void => {
  let offset = content.text.length;
  content.text += text;
  if (textFragmentIds === undefined || textFragmentIds.length === 0) return;
  for (const fragmentId of textFragmentIds) {
    const piece = builder.fragments[fragmentId];
    if (piece === undefined) throw new Error(`Unknown ReferenceBuilder fragment ${fragmentId}`);
    if (builder.fragmentPlacements.has(fragmentId)) throw new Error(`ReferenceBuilder fragment ${fragmentId} has multiple output occurrences`);
    builder.fragmentPlacements.set(fragmentId, { emittedFieldId: content.emittedFieldId, start: offset, endExclusive: offset + piece.length });
    offset += piece.length;
  }
  if (offset !== content.text.length) throw new Error('output IR text and its original parts have different lengths');
};

export const isReadFieldState = (value: unknown): value is ReadFieldState =>
  typeof value === 'object' && value !== null && fieldStatePhase in value && value[fieldStatePhase] === 'read';

const isEmittedFieldState = (value: unknown): value is EmittedFieldState =>
  typeof value === 'object' && value !== null && fieldStatePhase in value && value[fieldStatePhase] === 'emitted';

const textView = (kind: ReferenceKind, value: unknown): string | undefined => {
  if (kind === 'text') return typeof value === 'string' ? value : undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return JSON.stringify(value);
};

export const pairedChildren = function* (value: unknown, state: unknown): Generator<readonly [string | number, unknown, unknown]> {
  if (Array.isArray(state)) {
    if (!Array.isArray(value)) throw new TypeError('ReferenceBuilder state array does not match its assistant turn');
    for (let index = 0; index < state.length; index++) {
      if (!Object.hasOwn(state, index)) continue;
      yield [index, value[index], state[index]];
    }
    return;
  }
  if (typeof state !== 'object' || state === null) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('ReferenceBuilder state object does not match its assistant turn');
  for (const [key, childState] of Object.entries(state)) yield [key, Reflect.get(value, key), childState];
};

export function collectEmittedFieldPlacements(value: unknown, contentState: EmittedFieldState): Map<EmittedFieldId, TextPlacement>;
export function collectEmittedFieldPlacements<Protocol extends keyof InputAssistantTurnByProtocol>(
  turn: InputAssistantTurnFor<Protocol>,
  contentState: InputAssistantTurnStateFor<Protocol, EmittedFieldStates>,
  textPlacements?: TextPlacementIndex,
): Map<EmittedFieldId, TextPlacement>;
export function collectEmittedFieldPlacements(turn: unknown, contentState: unknown, textPlacements?: TextPlacementIndex): Map<EmittedFieldId, TextPlacement> {
  const views = new Map<EmittedFieldId, TextPlacement>();
  const visit = (value: unknown, state: unknown, channel?: TextPlacement): void => {
    if (isEmittedFieldState(state)) {
      const view = textView(state.kind, value);
      if (view === state.text) views.set(state.emittedFieldId, channel ?? { enclosingText: view, offset: 0 });
      return;
    }
    for (const [key, childValue, childState] of pairedChildren(value, state)) {
      const channel = typeof value === 'object' && value !== null ? textPlacements?.get(value)?.get(String(key)) : undefined;
      visit(childValue, childState, channel !== undefined && isEmittedFieldState(childState) && childState.kind === 'text' ? channel : undefined);
    }
  };
  visit(turn, contentState);
  return views;
}

const restoresOriginal = <Kind extends ReferenceKind>(field: ReadFieldState<Kind>, original: OriginalFor<Kind>): boolean => {
  if (!field.valid) return false;
  if (field.kind === 'text') return typeof original === 'string' && field.text === original;
  if (typeof original !== 'object' || original === null || Array.isArray(original)) return false;
  try {
    return JSON.stringify(parseJSONObject(field.text)) === JSON.stringify(original);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
};

interface ReferenceRun {
  readonly hashIndex: number;
  readonly start: number;
  endExclusive: number;
  readonly contentLength: number;
}

interface PlacedFragment {
  readonly emittedFieldId: EmittedFieldId;
  readonly content: string;
  readonly start: number;
  readonly endExclusive: number;
}

interface FieldReferencer {
  readonly referencedContentHashes: Uint8Array[];
  referenceField: <Kind extends ReferenceKind>(
    original: OriginalFor<Kind>,
    field: ReadFieldState<Kind>,
  ) => Promise<OriginalFor<Kind> | ContentReference<Kind>>;
}

export const createFieldReferencer = (builder: ReferenceBuilder, emittedFieldPlacements: ReadonlyMap<EmittedFieldId, TextPlacement>): FieldReferencer => {
  const referencedContentHashes: Uint8Array[] = [];
  const hashIndexByContentId = new Map<EmittedFieldId, number>();
  const hashIndexByContent = new Map<string, number>();
  const hashIndexByDigest = new Map<string, number>();

  const hashIndex = async (emittedFieldId: EmittedFieldId, content: string): Promise<number> => {
    const resolved = hashIndexByContentId.get(emittedFieldId);
    if (resolved !== undefined) return resolved;
    const existing = hashIndexByContent.get(content);
    if (existing !== undefined) {
      hashIndexByContentId.set(emittedFieldId, existing);
      return existing;
    }
    const digest = await hashRoundTripContent(content);
    const key = encodeHex(digest);
    let index = hashIndexByDigest.get(key);
    if (index === undefined) {
      index = referencedContentHashes.length;
      referencedContentHashes.push(digest);
      hashIndexByDigest.set(key, index);
    }
    hashIndexByContent.set(content, index);
    hashIndexByContentId.set(emittedFieldId, index);
    return index;
  };

  const referenceField = async <Kind extends ReferenceKind>(
    original: OriginalFor<Kind>,
    field: ReadFieldState<Kind>,
  ): Promise<OriginalFor<Kind> | ContentReference<Kind>> => {
    if (field.textFragmentIds.length === 0 || !restoresOriginal(field, original)) return original;
    const resolved: PlacedFragment[] = [];
    for (const fragmentId of field.textFragmentIds) {
      const piece = builder.fragments[fragmentId];
      const resolution = builder.fragmentPlacements.get(fragmentId);
      if (piece === undefined || resolution === undefined) return original;
      const view = emittedFieldPlacements.get(resolution.emittedFieldId);
      if (view === undefined) return original;
      const start = view.offset + resolution.start;
      const endExclusive = view.offset + resolution.endExclusive;
      if (view.enclosingText.slice(start, endExclusive) !== piece) return original;
      resolved.push({ emittedFieldId: resolution.emittedFieldId, content: view.enclosingText, start, endExclusive });
    }
    const segments: ReferenceRun[] = [];
    for (const resolution of resolved) {
      const index = await hashIndex(resolution.emittedFieldId, resolution.content);
      const previous = segments.at(-1);
      if (previous?.hashIndex === index && previous.endExclusive === resolution.start) previous.endExclusive = resolution.endExclusive;
      else segments.push({ hashIndex: index, start: resolution.start, endExclusive: resolution.endExclusive, contentLength: resolution.content.length });
    }
    const payload: ContentReferenceSegment[] = segments.map(segment => segment.start === 0 && segment.endExclusive === segment.contentLength
      ? segment.hashIndex
      : [segment.hashIndex, segment.start, segment.endExclusive]);
    return new ContentReference(field.kind, payload);
  };

  return { referencedContentHashes, referenceField };
};
