import { describe, expect, it } from 'vitest';

import { shortAccountId } from '../../../src/components/upstream-editor/account-id';

describe('account id elision', () => {
  it('elides only ids long enough to need it', () => {
    expect(shortAccountId('short-id')).toBe('short-id');
    expect(shortAccountId('acct_0123456789abcdef')).toBe('acct_012…abcdef');
  });

  it('never renders a character of the id twice, and never grows it', () => {
    for (let length = 1; length <= 40; length += 1) {
      const id = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'.slice(0, length);
      const short = shortAccountId(id);
      expect(short.length).toBeLessThanOrEqual(id.length);
      const [head, tail] = short.split('…');
      if (tail !== undefined) expect(head!.length + tail.length).toBeLessThanOrEqual(id.length);
    }
  });
});
