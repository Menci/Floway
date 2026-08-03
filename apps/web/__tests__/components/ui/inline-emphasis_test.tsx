import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InlineMarkdown } from '../../../src/components/ui/markdown';
import en from '../../../src/i18n/locales/en';
import zhHans from '../../../src/i18n/locales/zh-Hans';
import { leafEntries } from '../../i18n/keys';
import { renderInApp } from '../../render';

const locales = { en, 'zh-Hans': zhHans };

// Operator copy is authored in the renderer's dialect, and that dialect decides
// whether a delimiter run opens emphasis from the characters around it -- so a
// bold run that sits directly against CJK text is the case where the two can
// disagree, and disagreeing means the asterisks reach the operator. A
// description carries its paragraphs as single newlines, which the renderer
// reads as soft breaks, so each line is measured the way the flag list renders
// it.
describe('emphasis in operator copy', () => {
  it('renders as emphasis in every locale rather than reaching the page as asterisks', () => {
    const unrendered: string[] = [];
    for (const [locale, resource] of Object.entries(locales)) {
      for (const [key, value] of leafEntries(resource.translation)) {
        for (const line of value.split('\n')) {
          if (!line.includes('**')) continue;
          const { unmount } = renderInApp(<div data-testid="prose"><InlineMarkdown>{line}</InlineMarkdown></div>);
          const prose = screen.getByTestId('prose');
          if (prose.textContent?.includes('**') || prose.querySelector('strong') === null) {
            unrendered.push(`${locale}:${key}`);
          }
          unmount();
        }
      }
    }
    expect(unrendered).toEqual([]);
  });
});
