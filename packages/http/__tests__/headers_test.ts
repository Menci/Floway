import { describe, expect, it } from 'vitest';

import { appendHeader, deleteHeader, filterHeaders, getHeader, getHeaders, hasHeader, materializeHeaders, responseHeaderEntries, setHeader, type HttpHeaders } from '../src/index.ts';
import { Secret } from '@floway-dev/pipeline';

describe('HTTP fact headers', () => {
  it('looks up repeated names without altering their values or marking', () => {
    const secret = Secret.from('Bearer upstream');
    const headers: HttpHeaders = [['Authorization', secret], ['authorization', 'operator value'], ['Vary', 'Content-Type']];

    expect(getHeader(headers, 'AUTHORIZATION')).toBe(secret);
    expect(getHeaders(headers, 'authorization')).toEqual([secret, 'operator value']);
    expect(getHeaders(headers, 'missing')).toEqual([]);
    expect(hasHeader(headers, 'vary')).toBe(true);
    expect(hasHeader(headers, 'missing')).toBe(false);
    expect(materializeHeaders(headers)).toEqual([
      ['Authorization', 'Bearer upstream'], ['authorization', 'operator value'], ['Vary', 'Content-Type'],
    ]);
    expect(headers[0]?.[1]).toBe(secret);
  });

  it('updates, appends, removes and filters without changing the prior array', () => {
    const keep: HttpHeaders[number] = ['Vary', 'Content-Type'];
    const headers: HttpHeaders = [['X-Target', 'one'], keep, ['x-target', 'two']];

    const updated = setHeader(headers, 'X-TARGET', 'new');
    expect(updated).toEqual([['X-Target', 'new'], keep]);
    expect(updated[1]).toBe(keep);
    expect(setHeader(headers, 'New', 'value')).toEqual([...headers, ['New', 'value']]);
    expect(appendHeader(headers, 'X-Target', 'three')).toEqual([...headers, ['X-Target', 'three']]);
    expect(filterHeaders(headers, name => name === 'x-target')).toEqual([headers[0], headers[2]]);
    expect(deleteHeader(headers, 'X-TARGET')).toEqual([keep]);
    expect(headers).toHaveLength(3);
  });

  it('extracts separate Set-Cookie lines from a Fetch response', () => {
    const response = new Response(null, {
      headers: [
        ['set-cookie', 'first=a; Expires=Wed, 25 Nov 2026 12:00:00 GMT'],
        ['set-cookie', 'second=b'],
      ],
    });

    expect(responseHeaderEntries(response)).toEqual([
      ['set-cookie', 'first=a; Expires=Wed, 25 Nov 2026 12:00:00 GMT'],
      ['set-cookie', 'second=b'],
    ]);
  });
});
