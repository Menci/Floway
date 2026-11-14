import { ContentReference, type ContentReferenceSegment } from './types.ts';
import { rawJSON } from '../../shared/json/raw-json.ts';
import { SidecarTaggedValue } from '../codec.ts';

const THIN_TEXT_TAG = 65_536;
const THIN_JSON_TAG = 65_537;

const isReferenceIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isContentReferenceSegment = (value: unknown): value is ContentReferenceSegment => isReferenceIndex(value)
  || (Array.isArray(value) && value.length === 3 && value.every(isReferenceIndex) && value[1] <= value[2]);

// Rebuilds only the containers on a path to a replaced leaf and shares every other node.
const mapLeaves = (value: unknown, replace: (value: unknown) => unknown): unknown => {
  const replaced = replace(value);
  if (replaced !== value || value instanceof SidecarTaggedValue || value instanceof ContentReference || value instanceof Uint8Array || rawJSON.isRawJSON(value)) return replaced;
  if (Array.isArray(value)) {
    const children = value.map(child => mapLeaves(child, replace));
    return children.every((child, index) => child === value[index]) ? value : children;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).map(([key, child]) => [key, child, mapLeaves(child, replace)] as const);
    return entries.every(([, child, mapped]) => mapped === child) ? value : Object.fromEntries(entries.map(([key, , mapped]) => [key, mapped]));
  }
  return value;
};

/** Replaces translate-owned references with transport-owned tagged values. */
export const tagContentReferences = (value: unknown): unknown => mapLeaves(value, leaf => leaf instanceof ContentReference
  ? new SidecarTaggedValue(leaf.kind === 'text' ? THIN_TEXT_TAG : THIN_JSON_TAG, leaf.parts)
  : leaf);

/** Restores translate-owned references from transport-owned tagged values. */
export const untagContentReferences = (value: unknown): unknown => mapLeaves(value, leaf => {
  if (!(leaf instanceof SidecarTaggedValue) || (leaf.tag !== THIN_TEXT_TAG && leaf.tag !== THIN_JSON_TAG)) return leaf;
  const parts: unknown = leaf.value;
  if (!Array.isArray(parts) || !parts.every(isContentReferenceSegment)) throw new TypeError('Thin reference sidecar tag requires reference parts');
  return new ContentReference(leaf.tag === THIN_TEXT_TAG ? 'text' : 'json', parts);
});
