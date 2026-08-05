import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TelemetryDimensionControls } from '../../../src/components/telemetry/dimension-controls';
import { renderInApp } from '../../render';

describe('telemetry dimension controls', () => {
  it('labels the grouping composite and omits the active dimension filter', () => {
    renderInApp(<TelemetryDimensionControls
      disabled={false}
      dimensions={[
        { key: 'model', groupLabel: 'By Model', filterLabel: 'Model', allLabel: 'All models', options: [] },
        { key: 'upstream', groupLabel: 'By Upstream', filterLabel: 'Upstream', allLabel: 'All upstreams', options: [] },
      ]}
      filters={{ model: [], upstream: [] }}
      groupBy="model"
      groupByLabel="Group by"
      onFilterChange={vi.fn()}
      onGroupByChange={vi.fn()}
      selectedLabel={count => `${count} selected`}
    />);

    const group = screen.getByRole('group', { name: 'Group by' });
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Group by');
    expect(screen.getByRole('combobox', { name: 'Group by' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Upstream' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  });
});
