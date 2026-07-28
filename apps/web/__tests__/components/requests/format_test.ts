import { describe, expect, it } from 'vitest';

import { errorLabel } from '../../../src/components/requests/format';

describe('request error labels', () => {
  it('uses the no-status canary for failures without an HTTP response', () => {
    expect(errorLabel({ kind: 'gateway' }, null)).toBe('gateway error ???');
    expect(errorLabel({ kind: 'upstream' }, 0)).toBe('upstream error ???');
  });
});
