import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InlineMarkdown } from '../../../src/components/ui/markdown';
import zhHans from '../../../src/i18n/locales/zh-Hans';
import { renderInApp } from '../../render';

const flags = zhHans.translation.dashboard.upstreamEditor.flags.entries as Record<string, { label: string; description: string }>;

describe('probe', () => {
  it('renders a zh-Hans description bold run', () => {
    const line = flags['vendor-qwen']!.description.split('\n')[2]!;
    renderInApp(<div data-testid="out"><InlineMarkdown>{line}</InlineMarkdown></div>);
    // eslint-disable-next-line no-console
    console.log('LINE:', JSON.stringify(line));
    // eslint-disable-next-line no-console
    console.log('HTML:', screen.getByTestId('out').innerHTML);
    expect(screen.getByTestId('out').textContent).not.toContain('**');
  });
});
