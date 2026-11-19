import { describe, expect, it } from 'vitest';

import { i18n, setLanguage } from '../../src/i18n';
import zhHans from '../../src/i18n/locales/zh-Hans';

// A session boots with its own language and nothing else, so reaching another
// one has to fetch that bundle first. happy-dom reports en-US, which leaves
// zh-Hans as the language nothing in this run has loaded.
describe('locale loading', () => {
  it('fetches a bundle the session has not seen before switching to it', async () => {
    expect(i18n.hasResourceBundle('zh-Hans', 'translation')).toBe(false);

    await setLanguage('zh-Hans');

    expect(i18n.language).toBe('zh-Hans');
    expect(i18n.t('common.loading')).toBe(zhHans.translation.common.loading);
  });
});
