import { describe, expect, test } from 'vitest';

import {
  isJsonMediaType,
  isTextualMediaType,
  mediaTypeEssence,
  parseMediaType,
} from '../../src/common/media-type.ts';

describe('media type parsing', () => {
  test('normalizes casing and ignores parameters when deriving the essence', () => {
    expect(parseMediaType(' Application/Vnd.Api+JSON ; Charset="utf-8;strict" ')).toEqual({
      essence: 'application/vnd.api+json',
      type: 'application',
      subtype: 'vnd.api+json',
    });
    expect(mediaTypeEssence('text/plain;charset=utf-8')).toBe('text/plain');
  });

});

describe('media type classification', () => {
  test('recognizes JSON essences and structured suffixes without near matches', () => {
    expect(isJsonMediaType('Application/JSON; charset=utf-8')).toBe(true);
    expect(isJsonMediaType('application/problem+json')).toBe(true);
    expect(isJsonMediaType('text/example+json')).toBe(true);
    expect(isJsonMediaType('application/json-seq')).toBe(false);
    expect(isJsonMediaType('application/jsonish')).toBe(false);
    expect(isJsonMediaType('application/+json')).toBe(false);
  });

  test('classifies textual wire bodies from exact media types', () => {
    expect(isTextualMediaType('text/csv')).toBe(true);
    expect(isTextualMediaType('application/activity+json')).toBe(true);
    expect(isTextualMediaType('image/svg+xml')).toBe(true);
    expect(isTextualMediaType('application/javascript')).toBe(true);
    expect(isTextualMediaType('application/x-www-form-urlencoded')).toBe(true);
    expect(isTextualMediaType('application/jsonish')).toBe(false);
    expect(isTextualMediaType('application/javascript-debug')).toBe(false);
  });
});
