import { describe, expect, it } from 'vitest';

import { entryMatchesColo, normalizeProxyFallbackList } from '../../src/repo/proxy-fallback-list.ts';

describe('entryMatchesColo', () => {
  it('treats missing colos as "active in all colos"', () => {
    expect(entryMatchesColo({ id: 'a' }, 'HKG')).toBe(true);
    expect(entryMatchesColo({ id: 'a' }, null)).toBe(true);
  });

  it('matches by exact case (CF returns uppercase, normalize already upper-cased the whitelist)', () => {
    expect(entryMatchesColo({ id: 'a', colos: ['HKG', 'NRT'] }, 'HKG')).toBe(true);
    expect(entryMatchesColo({ id: 'a', colos: ['HKG', 'NRT'] }, 'NRT')).toBe(true);
    expect(entryMatchesColo({ id: 'a', colos: ['HKG', 'NRT'] }, 'LAX')).toBe(false);
    expect(entryMatchesColo({ id: 'a', colos: ['HKG', 'NRT'] }, null)).toBe(false);
    // The contract is that callers feed already-normalised values; we don't
    // re-normalise here so a lower-case `currentColo` (a hypothetical bug
    // upstream) is intentionally a miss rather than a silent recovery.
    expect(entryMatchesColo({ id: 'a', colos: ['HKG'] }, 'hkg')).toBe(false);
  });
});

describe('normalizeProxyFallbackList', () => {
  it('drops duplicate ids keeping the first occurrence', () => {
    expect(normalizeProxyFallbackList([
      { id: 'a' },
      { id: 'b', colos: ['HKG'] },
      { id: 'a', colos: ['NRT'] },
    ])).toEqual([
      { id: 'a' },
      { id: 'b', colos: ['HKG'] },
    ]);
  });

  it('uppercases colos, trims whitespace, dedupes within each entry', () => {
    expect(normalizeProxyFallbackList([
      { id: 'a', colos: [' hkg ', 'NRT', 'hkg', ''] },
    ])).toEqual([
      { id: 'a', colos: ['HKG', 'NRT'] },
    ]);
  });
});
