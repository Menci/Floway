import { expect, test } from 'vitest';

import { appendHeader, deleteHeader, filterHeaders, getHeader, getHeaderEntry, hasHeader, mergeHeaders, setHeader } from '../src/headers.ts';
import type { HeaderEntry } from '@floway-dev/http';
import { isSecret, secret } from '@floway-dev/pipeline';

const headers: readonly HeaderEntry[] = [
  ['X-First', 'first'],
  ['X-Repeat', 'original'],
  ['X-Middle', 'middle'],
  ['x-repeat', 'duplicate'],
  ['X-Last', 'last'],
];

test('updates the first case-insensitive match in place and discards later duplicates', () => {
  expect(setHeader(headers, 'x-repeat', 'replacement')).toEqual([
    ['X-First', 'first'], ['X-Repeat', 'replacement'], ['X-Middle', 'middle'], ['X-Last', 'last'],
  ]);
  expect(setHeader(headers, 'x-new', 'new')).toEqual([...headers, ['x-new', 'new']]);
  expect(getHeader(headers, 'X-REPEAT')).toBe('original');
  expect(hasHeader(headers, 'x-First')).toBe(true);
  expect(hasHeader(headers, 'x-new')).toBe(false);
});

test('appends duplicate values and filters using lowercase names without changing stored names', () => {
  const appended = appendHeader(headers, 'x-repeat', 'third');
  expect(filterHeaders(appended, name => name === 'x-repeat')).toEqual([
    ['X-Repeat', 'original'], ['x-repeat', 'duplicate'], ['x-repeat', 'third'],
  ]);
  expect(deleteHeader(appended, 'X-Repeat')).toEqual([headers[0], headers[2], headers[4]]);
});

test('merges updates in base order and appends new names in addition order', () => {
  expect(mergeHeaders(headers, [['X-New', 'new'], ['x-last', 'changed'], ['x-repeat', 'replacement'], ['x-second', 'second']])).toEqual([
    ['X-First', 'first'], ['X-Repeat', 'replacement'], ['X-Middle', 'middle'], ['X-Last', 'changed'], ['X-New', 'new'], ['x-second', 'second'],
  ]);
});

test('stores sensitive headers as secrets and reveals them only through the value lookup', () => {
  const authorization = secret('Bearer token');
  const first = setHeader([], 'Authorization', authorization);
  const result = appendHeader(first, 'x-api-key', 'credential');
  expect(getHeaderEntry(result, 'authorization')?.[1]).toBe(authorization);
  expect(isSecret(getHeaderEntry(result, 'X-API-KEY')?.[1])).toBe(true);
  expect(getHeader(result, 'x-api-key')).toBe('credential');
  expect(getHeader(result, 'AUTHORIZATION')).toBe('Bearer token');
});
