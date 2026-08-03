import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

import { recordSummary } from '../../../src/components/backup-restore/summary';
import type { SupportedLanguage } from '../../../src/i18n/languages';
import { loadLocale } from '../../../src/i18n/resources';

const translator = async (language: SupportedLanguage) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: language,
    resources: { [language]: await loadLocale(language) },
    interpolation: { escapeValue: false },
  });
  return instance.t.bind(instance);
};

// The sentence the operator is left with after an import. It is assembled from
// three separate mechanisms -- i18next's plural categories, `formatCount`'s
// grouping and `Intl.ListFormat`'s conjunction -- none of which the other two
// can cover for, so each is pinned here against text a person would write.
describe('what an import reports it took', () => {
  it('agrees the noun with the count and groups the figure', async () => {
    const t = await translator('en');
    expect(recordSummary({ users: 1, proxies: 1 }, t, 'en')).toBe('1 user and 1 proxy');
    expect(recordSummary({ users: 2 }, t, 'en')).toBe('2 users');
    expect(recordSummary({ usage: 18309 }, t, 'en')).toBe('18,309 usage records');
  });

  it('closes a written list with a conjunction rather than a comma', async () => {
    const t = await translator('en');
    expect(recordSummary({ users: 1, apiKeys: 8, upstreams: 3, proxies: 1, usage: 18309, searchUsage: 263 }, t, 'en'))
      .toBe('1 user, 8 API keys, 3 upstreams, 1 proxy, 18,309 usage records, and 263 search-usage records');
  });

  it('names nothing the file did not carry', async () => {
    const t = await translator('en');
    expect(recordSummary({ users: 2, apiKeys: 0, performance: 0 }, t, 'en')).toBe('2 users');
    expect(recordSummary({ users: 0 }, t, 'en')).toBe('');
  });

  // Chinese inflects no plural and separates a list with its own punctuation --
  // an enumeration comma between the items and 和 before the last, with no
  // space around it -- so the same call has to reach both languages without the
  // English shape showing through.
  it('reads as Chinese under zh-Hans', async () => {
    const t = await translator('zh-Hans');
    expect(recordSummary({ users: 1, usage: 18309 }, t, 'zh-Hans')).toBe('1 个用户和18,309 条使用记录');
    expect(recordSummary({ users: 1, apiKeys: 8, upstreams: 3 }, t, 'zh-Hans')).toBe('1 个用户、8 个 API 密钥和3 个上游');
  });
});
