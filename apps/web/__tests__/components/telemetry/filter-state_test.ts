import { describe, expect, it } from 'vitest';

import { clearGroupedTelemetryFilters, scopeTelemetryIdentity, telemetryFilterDimensions } from '../../../src/components/telemetry/filter-state';

const filters = { model: ['gpt-5'], upstream: ['up-1'], userId: ['2'], keyId: ['key-1'] };

describe('telemetry filter state', () => {
  it('clears the active shared dimension and couples identity dimensions', () => {
    expect(clearGroupedTelemetryFilters(filters, 'upstream')).toEqual({ ...filters, upstream: [] });
    expect(clearGroupedTelemetryFilters(filters, 'userId')).toEqual({ ...filters, userId: [], keyId: [] });
  });

  it('normalizes an unavailable user grouping without retaining hidden filters', () => {
    expect(scopeTelemetryIdentity('userId', filters, false, 'model')).toEqual({
      groupBy: 'model',
      filters: { model: [], upstream: ['up-1'], userId: [], keyId: ['key-1'] },
    });
  });

  it('uses one identity-filter visibility rule for every telemetry page', () => {
    const dimensions = ['model', 'upstream', 'userId', 'keyId'].map(key => ({ key }));

    expect(telemetryFilterDimensions(dimensions, 'model').map(({ key }) => key))
      .toEqual(['upstream', 'userId', 'keyId']);
    expect(telemetryFilterDimensions(dimensions, 'userId').map(({ key }) => key))
      .toEqual(['model', 'upstream']);
    expect(telemetryFilterDimensions(dimensions, 'keyId').map(({ key }) => key))
      .toEqual(['model', 'upstream']);
  });
});
