import { describe, expect, it } from 'vitest';

import { errorLabel } from '../../../src/components/requests/format';

describe('request error labels', () => {
  it('uses the no-status canary for failures without an HTTP response', () => {
    expect(errorLabel({ kind: 'gateway' }, null)).toBe('gateway error ???');
    expect(errorLabel({ kind: 'upstream' }, 0)).toBe('upstream error ???');
  });

  it('drops the status entirely when the caller shows it elsewhere', () => {
    expect(errorLabel({ kind: 'gateway' })).toBe('gateway error');
    expect(errorLabel({ kind: 'failed', reason: 'socket closed' })).toBe('socket closed');
  });
});
