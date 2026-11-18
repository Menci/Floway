import { describe, expect, it } from 'vitest';

import { mergeResults } from '../../src/api/partial-results';

describe('partial page loads', () => {
  it('keeps what is on screen for the region that failed', () => {
    const catalog = ['stable'];
    const { values, errors, error } = mergeResults(
      { aliases: [] as string[], models: catalog as string[] | null },
      {
        aliases: { data: ['virtual'] },
        models: { error: { status: 503, message: 'catalog unavailable' } },
      },
    );

    expect(values.aliases).toEqual(['virtual']);
    expect(values.models).toBe(catalog);
    expect(errors).toEqual({ aliases: null, models: 'catalog unavailable' });
    expect(error).toBe('catalog unavailable');
  });

  it('reports the first failure in the order the page listed its requests', () => {
    const { error } = mergeResults(
      { keys: null as string[] | null, upstreams: null as string[] | null },
      {
        keys: { error: { status: 500, message: 'keys unavailable' } },
        upstreams: { error: { status: 500, message: 'upstreams unavailable' } },
      },
    );

    expect(error).toBe('keys unavailable');
  });
});
