import { afterEach, describe, expect, it } from 'vitest';

import { recordSummary } from '../../../src/components/backup-restore/summary';
import { i18n, setLanguage } from '../../../src/i18n';
import { defaultLanguage, localeForLanguage } from '../../../src/i18n/languages';
import type { TFunction } from '../../../src/i18n/translation';

// The sentence the operator is left with after an import. It is assembled from
// three separate mechanisms -- i18next's plural categories, `formatNumber`'s
// grouping and `Intl.ListFormat`'s conjunction -- none of which the other two
// can cover for, so each is pinned here against text a person would write. It
// runs through the app's own i18next instance and the locale the route hands
// the function: the grouping is our formatter rather than i18next's built-in
// Intl, and the two resolve a locale differently.
const summary = (counts: Record<string, number>) =>
  recordSummary(counts, i18n.t.bind(i18n) as unknown as TFunction, localeForLanguage(i18n.language));

describe('what an import reports it took', () => {
  afterEach(async () => { await setLanguage(defaultLanguage); });

  it('agrees the noun with the count and groups the figure', () => {
    expect(summary({ users: 1, proxies: 1 })).toBe('1 user and 1 proxy');
    expect(summary({ users: 2 })).toBe('2 users');
    expect(summary({ usage: 18309 })).toBe('18,309 usage records');
  });

  it('closes a written list with a conjunction rather than a comma', () => {
    expect(summary({ users: 1, apiKeys: 8, upstreams: 3, proxies: 1, usage: 18309, searchUsage: 263 }))
      .toBe('1 user, 8 API keys, 3 upstreams, 1 proxy, 18,309 usage records, and 263 search-usage records');
  });

  it('names nothing the file did not carry', () => {
    expect(summary({ users: 2, apiKeys: 0, performance: 0 })).toBe('2 users');
    expect(summary({ users: 0 })).toBe('');
  });

  // Chinese inflects no plural and separates a list with its own punctuation --
  // an enumeration comma between the items and 和 before the last, with no
  // space around it -- so the same call has to reach both languages without the
  // English shape showing through.
  it('reads as Chinese under zh-Hans', async () => {
    await setLanguage('zh-Hans');
    expect(summary({ users: 1, usage: 18309 })).toBe('1 个用户和18,309 条使用记录');
    expect(summary({ users: 1, apiKeys: 8, upstreams: 3 })).toBe('1 个用户、8 个 API 密钥和3 个上游');
  });
});
