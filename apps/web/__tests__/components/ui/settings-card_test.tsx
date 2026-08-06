import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SettingsExpander } from '../../../src/components/ui/settings-card';
import { renderInApp } from '../../render';

describe('settings expander', () => {
  it('keeps its chevron inside the disclosure hit target', () => {
    const { container } = renderInApp(<SettingsExpander header="Advanced settings">Contents</SettingsExpander>);
    const disclosure = screen.getByRole('button', { name: 'Advanced settings' });
    const chevron = container.querySelector('svg')?.parentElement;
    if (!chevron) throw new Error('the settings expander drew no chevron');

    expect(getComputedStyle(chevron).pointerEvents).toBe('none');
    fireEvent.click(disclosure);

    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  });
});
