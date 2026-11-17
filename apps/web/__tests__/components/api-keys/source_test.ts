import { describe, expect, it } from 'vitest';

import { keyWriteBody } from '../../../src/components/api-keys/source';

describe('API key write body', () => {
  it('trims and sends a caller-provided custom key', () => {
    expect(keyWriteBody('custom', '  bring-your-own-key  ')).toEqual({
      key_source: 'custom',
      custom_key: 'bring-your-own-key',
    });
  });
});
