import { format, parse } from 'content-type';

export interface ParsedMediaType {
  readonly essence: string;
  readonly type: string;
  readonly subtype: string;
}

export const parseMediaType = (value: string | null | undefined): ParsedMediaType | null => {
  if (value === null || value === undefined) return null;

  const essence = parse(value, { parameters: false }).type;
  try {
    format({ type: essence });
  } catch {
    return null;
  }

  const separator = essence.indexOf('/');
  return {
    essence,
    type: essence.slice(0, separator),
    subtype: essence.slice(separator + 1),
  };
};

export const mediaTypeEssence = (value: string | null | undefined): string | null =>
  parseMediaType(value)?.essence ?? null;

export const isMediaType = (value: string | null | undefined, essence: string): boolean =>
  mediaTypeEssence(value) === essence;

const hasStructuredSuffix = (subtype: string, suffix: string): boolean =>
  subtype.length > suffix.length + 1 && subtype.endsWith(`+${suffix}`);

export const isJsonMediaType = (value: string | null | undefined): boolean => {
  const parsed = parseMediaType(value);
  return parsed !== null
    && (parsed.essence === 'application/json' || hasStructuredSuffix(parsed.subtype, 'json'));
};

export const isXmlMediaType = (value: string | null | undefined): boolean => {
  const parsed = parseMediaType(value);
  return parsed !== null
    && (parsed.essence === 'application/xml'
      || parsed.essence === 'text/xml'
      || hasStructuredSuffix(parsed.subtype, 'xml'));
};

export const isTextualMediaType = (value: string | null | undefined): boolean => {
  const parsed = parseMediaType(value);
  return parsed !== null
    && (parsed.type === 'text'
      || isJsonMediaType(parsed.essence)
      || isXmlMediaType(parsed.essence)
      || parsed.essence === 'application/javascript'
      || parsed.essence === 'application/x-www-form-urlencoded');
};

export const isEventStreamMediaType = (value: string | null | undefined): boolean =>
  isMediaType(value, 'text/event-stream');

export const isImageMediaType = (value: string | null | undefined): boolean =>
  parseMediaType(value)?.type === 'image';

export const isMultipartFormDataMediaType = (value: string | null | undefined): boolean =>
  isMediaType(value, 'multipart/form-data');
