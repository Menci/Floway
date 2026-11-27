import { parse, validate, version } from 'uuid';
import { expect, test } from 'vitest';

import { sha256JsonUuid } from '../src/ids.ts';

test('sha256JsonUuid preserves the legacy concatenated JSON digest', async () => {
  const value = [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }];
  const prefix = 'instructions\u0001';
  const id = sha256JsonUuid(value, prefix);
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${prefix}${JSON.stringify(value)}`),
  )).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;

  expect(id).toBe('1c2f7ec8-b105-4f3d-9be3-e52e795f1423');
  expect([...parse(id)]).toEqual([...digest]);
  expect(validate(id)).toBe(true);
  expect(version(id)).toBe(4);
  expect(parse(id)[8] & 0xc0).toBe(0x80);
});
