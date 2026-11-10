import { ContentReference, type AssistantTurnStateFor, type ContentReferenceSegment } from './assistant-turn.ts';
import type { IRJSONObject } from '../../ir/types.ts';
import { parseJSONObject } from '../../shared/json/object.ts';
import type { AssistantTurnByProtocol, AssistantTurnFor } from '../assistant-turn.ts';
import type { TextPlacement, TextPlacementIndex } from '../text-groups.ts';
import { hashRoundTripContent } from '../turn-digest.ts';
import { encodeHex } from '@floway-dev/protocols/common';

const stateKind: unique symbol = Symbol('ReferenceState');

export type ReferencePieceId = number;
type ContentId = number;
type ReferenceKind = 'text' | 'json';

export interface ReferenceBuilder {
  readonly pieces: string[];
  readonly resolutions: Map<ReferencePieceId, Resolution>;
  nextContentId: number;
}

type OriginalFor<Kind extends ReferenceKind> = Kind extends 'text' ? string : IRJSONObject;

export interface FieldState<Kind extends ReferenceKind = ReferenceKind> {
  readonly [stateKind]: 'field';
  readonly kind: Kind;
  valid: boolean;
  text: string;
  readonly referencePieceIds: ReferencePieceId[];
}

export interface ContentState<Kind extends ReferenceKind = ReferenceKind> {
  readonly [stateKind]: 'content';
  readonly kind: Kind;
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

export const createFieldState = <Kind extends ReferenceKind>(kind: Kind): FieldState<Kind> => ({
  [stateKind]: 'field', kind, valid: true, text: '', referencePieceIds: [],
});

export const appendField = (builder: ReferenceBuilder, field: FieldState, text: string): ReferencePieceId => {
  if (!field.valid) throw new Error('Cannot append provenance to an invalid field');
  const partId = builder.pieces.length;
  builder.pieces.push(text);
  field.text += text;
  field.referencePieceIds.push(partId);
  return partId;
};

export const invalidateField = (field: FieldState): void => { field.valid = false; };

export const createContentState = <Kind extends ReferenceKind>(builder: ReferenceBuilder, kind: Kind): ContentState<Kind> => ({
  [stateKind]: 'content', kind, contentId: builder.nextContentId++, text: '',
});

export const appendContent = (builder: ReferenceBuilder, content: ContentState, text: string, referencePieceIds?: readonly ReferencePieceId[]): void => {
  let offset = content.text.length;
  content.text += text;
  if (referencePieceIds === undefined || referencePieceIds.length === 0) return;
  for (const partId of referencePieceIds) {
    const piece = builder.pieces[partId];
    if (piece === undefined) throw new Error(`Unknown ReferenceBuilder part ${partId}`);
    if (builder.resolutions.has(partId)) throw new Error(`ReferenceBuilder part ${partId} has multiple output occurrences`);
    builder.resolutions.set(partId, { contentId: content.contentId, start: offset, endExclusive: offset + piece.length });
    offset += piece.length;
  }
  if (offset !== content.text.length) throw new Error('IR text and its original parts have different lengths');
};

export const isFieldState = (value: unknown): value is FieldState =>
  typeof value === 'object' && value !== null && stateKind in value && value[stateKind] === 'field';

const isContentState = (value: unknown): value is ContentState =>
  typeof value === 'object' && value !== null && stateKind in value && value[stateKind] === 'content';

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

export function collectContentViews(value: unknown, contentState: ContentState): Map<ContentId, TextPlacement>;
export function collectContentViews<Protocol extends keyof AssistantTurnByProtocol>(
  turn: AssistantTurnFor<Protocol>,
  contentState: AssistantTurnStateFor<Protocol, ContentStates>,
  textViews?: TextPlacementIndex,
): Map<ContentId, TextPlacement>;
export function collectContentViews(turn: unknown, contentState: unknown, textViews?: TextPlacementIndex): Map<ContentId, TextPlacement> {
  const views = new Map<ContentId, TextPlacement>();
  const visit = (value: unknown, state: unknown, channel?: TextPlacement): void => {
    if (isContentState(state)) {
      const view = textView(state.kind, value);
      if (view === state.text) views.set(state.contentId, channel ?? { text: view, offset: 0 });
      return;
    }
    for (const [key, childValue, childState] of pairedChildren(value, state)) {
      const channel = typeof value === 'object' && value !== null ? textViews?.get(value)?.get(String(key)) : undefined;
      visit(childValue, childState, channel !== undefined && isContentState(childState) && childState.kind === 'text' ? channel : undefined);
    }
  };
  visit(turn, contentState);
  return views;
}

const restoresOriginal = <Kind extends ReferenceKind>(field: FieldState<Kind>, original: OriginalFor<Kind>): boolean => {
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
  readonly referencedContentHashes: Uint8Array[];
  finalizeField: <Kind extends ReferenceKind>(
    original: OriginalFor<Kind>,
    field: FieldState<Kind>,
  ) => Promise<OriginalFor<Kind> | ContentReference<Kind>>;
}

export const createReferenceFinalizer = (builder: ReferenceBuilder, contentViews: ReadonlyMap<ContentId, TextPlacement>): ReferenceFinalizer => {
  const referencedContentHashes: Uint8Array[] = [];
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
      index = referencedContentHashes.length;
      referencedContentHashes.push(digest);
      hashIndexByDigest.set(key, index);
    }
    hashIndexByContent.set(content, index);
    hashIndexByContentId.set(contentId, index);
    return index;
  };

  const finalizeField = async <Kind extends ReferenceKind>(
    original: OriginalFor<Kind>,
    field: FieldState<Kind>,
  ): Promise<OriginalFor<Kind> | ContentReference<Kind>> => {
    if (field.referencePieceIds.length === 0 || !restoresOriginal(field, original)) return original;
    const resolved: ResolvedSegment[] = [];
    for (const partId of field.referencePieceIds) {
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
    const payload: ContentReferenceSegment[] = segments.map(segment => segment.start === 0 && segment.endExclusive === segment.contentLength
      ? segment.hashIndex
      : [segment.hashIndex, segment.start, segment.endExclusive]);
    return new ContentReference(field.kind, payload);
  };

  return { referencedContentHashes, finalizeField };
};
