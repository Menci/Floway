import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { leafEntries } from '../../i18n/keys';
import { InlineMarkdown } from '../../../src/components/ui/markdown';
import en from '../../../src/i18n/locales/en';
import zhHans from '../../../src/i18n/locales/zh-Hans';
import { renderInApp } from '../../render';

const locales = { en, 'zh-Hans': zhHans };

describe('probe', () => {
  it('renders every emphasis run in both locales', () => {
    const literal: string[] = [];
    for (const [locale, resource] of Object.entries(locales)) {
      for (const [key, value] of leafEntries(resource.translation)) {
        for (const line of value.split('\n')) {
          if (!line.includes('**')) continue;
          const { unmount } = renderInApp(<div data-testid="out"><InlineMarkdown>{line}</InlineMarkdown></div>);
          const text = screen.getByTestId('out').textContent ?? '';
          if (text.includes('**')) literal.push(`${locale}:${key}: ${line}`);
          unmount();
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log('LITERAL:', JSON.stringify(literal, null, 2));
    expect(literal).toEqual([]);
  });
});
