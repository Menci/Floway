import { describe, expect, it } from 'vitest';

import { parseUsageUrlState } from '../../../src/components/usage/url-state';

describe('usage URL state', () => {
  it('preserves the user scope for API key grouping until the loader resolves the current user', () => {
    expect(parseUsageUrlState(new URLSearchParams('g=userId&fusr=2&fk=key-1')).filters).toMatchObject({ userId: [], keyId: [] });
    expect(parseUsageUrlState(new URLSearchParams('g=keyId&fusr=2&fk=key-1')).filters).toMatchObject({ userId: ['2'], keyId: [] });
  });
});
