import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { OTHER_SERIES_COLOR } from '../../../src/components/charts/palette';
import { ChartSection, type ChartSectionOther } from '../../../src/components/charts/section';
import type { SeriesLegendEntry } from '../../../src/components/charts/series-legends';
import { renderInApp } from '../../render';

const entries: SeriesLegendEntry[] = [
  { id: 'small', label: 'Small', hue: 10 },
  { id: 'large', label: 'Large', hue: 210 },
];

const other: ChartSectionOther = {
  color: OTHER_SERIES_COLOR,
  members: [
    { id: 'tail-a', label: 'Tail A' },
    { id: 'tail-b', label: 'Tail B' },
  ],
};

function Harness({ weights }: { weights?: ReadonlyMap<string, number> }) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  return <>
    <ChartSection
      controlsLabel="Series controls"
      emptyText="Empty"
      entries={entries}
      hidden={hidden}
      onHiddenChange={setHidden}
      other={other}
      title="Usage"
      weights={weights}
    >
      <div>plot</div>
    </ChartSection>
    <output data-testid="hidden">{JSON.stringify([...hidden].sort())}</output>
  </>;
}

const hiddenIds = () => JSON.parse(screen.getByTestId('hidden').textContent ?? '[]') as string[];

describe('ChartSection legend ranking and expandable Other', () => {
  it('ranks legend entries descending by weight and lists collapsed Other members in a bold Includes tooltip', async () => {
    renderInApp(<Harness weights={new Map([['small', 10], ['large', 500]])} />);

    const largeButton = screen.getByRole('button', { name: 'Large' });
    const smallButton = screen.getByRole('button', { name: 'Small' });
    expect(largeButton.compareDocumentPosition(smallButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    fireEvent.focus(screen.getByRole('button', { name: 'Other (2)' }));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.querySelector('strong')).not.toBeNull();
    expect(tooltip.textContent).toContain('Tail A, Tail B');
  });

  it('expands Other flat inline and stores only individual member ids in hidden state', () => {
    renderInApp(<Harness weights={new Map([['small', 10], ['large', 500]])} />);

    const otherPrimary = screen.getByRole('button', { name: 'Other (2)' });
    const expandButton = screen.getByRole('button', { name: 'Other (2) Expand' });
    expect(screen.queryByRole('button', { name: 'Tail A' })).toBeNull();

    fireEvent.click(expandButton);
    expect(screen.getByRole('button', { name: 'Other (2) Collapse' })).toBeTruthy();
    const tailA = screen.getByRole('button', { name: 'Tail A' });

    fireEvent.click(tailA);
    expect(hiddenIds()).toEqual(['tail-a']);
    expect(screen.getByRole('button', { name: 'Other (1/2)' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Other (1/2)' }));
    expect(hiddenIds()).toEqual(['tail-a', 'tail-b']);
    fireEvent.click(otherPrimary);
    expect(hiddenIds()).toEqual([]);

    fireEvent.click(otherPrimary, { shiftKey: true });
    expect(hiddenIds()).toEqual(['large', 'small']);

    fireEvent.click(screen.getByRole('button', { name: 'Invert series selection' }));
    expect(hiddenIds()).toEqual(['tail-a', 'tail-b']);
    fireEvent.click(screen.getByRole('button', { name: 'Hide all series' }));
    expect(hiddenIds()).toEqual(['large', 'small', 'tail-a', 'tail-b']);
    fireEvent.click(screen.getByRole('button', { name: 'Show all series' }));
    expect(hiddenIds()).toEqual([]);
  });
});
