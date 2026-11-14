import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TelemetryFilterFields, TelemetryGroupByField, type TelemetryDimension } from '../../../src/components/telemetry/dimension-controls';
import { renderInApp } from '../../render';

describe('telemetry dimension controls', () => {
  it('labels the grouping composite and omits the active dimension filter', () => {
    const dimensions: TelemetryDimension<'model' | 'upstream'>[] = [
      { key: 'model', groupLabel: 'By Model', filterLabel: 'Model', allLabel: 'All models', options: [] },
      { key: 'upstream', groupLabel: 'By Upstream', filterLabel: 'Upstream', allLabel: 'All upstreams', options: [] },
    ];
    renderInApp(<>
      <TelemetryGroupByField disabled={false} dimensions={dimensions} groupBy="model" groupByLabel="Group by" onGroupByChange={vi.fn()} />
      <TelemetryFilterFields disabled={false} dimensions={dimensions} filters={{ model: [], upstream: [] }} groupBy="model" onFilterChange={vi.fn()} selectedLabel={count => `${count} selected`} />
    </>);

    const group = screen.getByRole('group', { name: 'Group by' });
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Group by');
    expect(screen.getByRole('combobox', { name: 'Group by' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Upstream' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  });
});
