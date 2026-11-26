import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../src/lib/canonical-json';

describe('canonical JSON', () => {
  // An editor that clears a field and restores it writes the key back at the
  // end, and a draft that holds the same values must still read as unchanged.
  it('ignores key order at every depth', () => {
    expect(canonicalJson({ reasoning: { effort: 'low', summary: 'auto' }, verbosity: 'low' }))
      .toBe(canonicalJson({ verbosity: 'low', reasoning: { summary: 'auto', effort: 'low' } }));
  });

  it('keeps array order', () => {
    expect(canonicalJson([{ a: 1 }, { b: 2 }])).not.toBe(canonicalJson([{ b: 2 }, { a: 1 }]));
  });
});
