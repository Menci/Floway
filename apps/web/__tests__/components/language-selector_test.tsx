import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LanguageSelector } from '../../src/components/language-selector';
import { i18n, setLanguage } from '../../src/i18n';
import { flowayLanguageStorageKey } from '../../src/i18n/language-preference';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

describe('LanguageSelector', () => {
  const storage = stubLocalStorage();

  it('switches the dashboard language and remembers the choice', async () => {
    await setLanguage('en');

    renderInApp(<LanguageSelector />);
    const button = screen.getByRole('button', { name: 'Language' });

    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('menuitemradio', { name: '简体中文' }));

    await waitFor(() => expect(i18n.language).toBe('zh-Hans'));
    await waitFor(() => expect(storage.get(flowayLanguageStorageKey)).toBe('zh-Hans'));
  });
});
