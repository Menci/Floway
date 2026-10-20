import { ContentReference, type ContentReferenceSegment } from './assistant-turn.ts';
import { rawJSON } from '../../shared/json/raw-json.ts';
import { SidecarTaggedValue } from '../sidecar-tagged-value.ts';

const THIN_TEXT_TAG = 65_536;
const THIN_JSON_TAG = 65_537;

const isReferenceIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isContentReferenceSegment = (value: unknown): value is ContentReferenceSegment => isReferenceIndex(value)
  || (Array.isArray(value) && value.length === 3 && value.every(isReferenceIndex) && value[1] <= value[2]);

const mapValue = (value: unknown, transform: (value: unknown) => unknown): unknown => {
  const mapped = transform(value);
  if (mapped instanceof SidecarTaggedValue || mapped instanceof Uint8Array || rawJSON.isRawJSON(mapped)) return mapped;
  if (Array.isArray(mapped)) return mapped.map(child => mapValue(child, transform));
  if (typeof mapped === 'object' && mapped !== null) {
    return Object.fromEntries(Object.entries(mapped).map(([key, child]) => [key, mapValue(child, transform)]));
  }
  return mapped;
};

/** Replaces translate-owned references with transport-owned tagged values. */
export const encodeSidecarTaggedValues = (value: unknown): unknown => mapValue(value, value => {
  if (!(value instanceof ContentReference)) return value;
  return new SidecarTaggedValue(
    value.kind === 'text' ? THIN_TEXT_TAG : THIN_JSON_TAG,
    value.parts.map((part): ContentReferenceSegment => typeof part === 'number' ? part : [part[0], part[1], part[2]]),
  );
});

/** Restores translate-owned references from transport-owned tagged values in place. */
export const restoreSidecarTaggedValues = (value: unknown): unknown => {
  if (value instanceof SidecarTaggedValue) {
    if (value.tag === THIN_TEXT_TAG || value.tag === THIN_JSON_TAG) {
      const parts: unknown = value.value;
      if (!Array.isArray(parts) || !parts.every(isContentReferenceSegment)) throw new TypeError('Thin reference sidecar tag requires reference parts');
      return new ContentReference(value.tag === THIN_TEXT_TAG ? 'text' : 'json', parts);
    }
    return value;
  }
  if (value instanceof Uint8Array || rawJSON.isRawJSON(value)) return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) value[index] = restoreSidecarTaggedValues(value[index]);
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) Reflect.set(value, key, restoreSidecarTaggedValues(child));
  }
  return value;
};
