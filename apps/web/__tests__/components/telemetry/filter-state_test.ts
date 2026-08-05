import { describe, expect, it } from 'vitest';

import { clearGroupedTelemetryFilters, scopeTelemetryIdentity, telemetryDimensionExcludedByGroup } from '../../../src/components/telemetry/filter-state';

const filters = { model: ['gpt-5'], upstream: ['up-1'], userId: ['2'], keyId: ['key-1'] };

describe('telemetry filter state', () => {
  it('clears the active shared dimension and couples identity dimensions', () => {
    expect(clearGroupedTelemetryFilters(filters, 'upstream')).toEqual({ ...filters, upstream: [] });
    expect(clearGroupedTelemetryFilters(filters, 'userId')).toEqual({ ...filters, userId: [], keyId: [] });
  });

  it('uses one exclusion policy for active and coupled identity dimensions', () => {
    expect(telemetryDimensionExcludedByGroup('model', 'model')).toBe(true);
    expect(telemetryDimensionExcludedByGroup('userId', 'keyId')).toBe(true);
    expect(telemetryDimensionExcludedByGroup('keyId', 'userId')).toBe(true);
    expect(telemetryDimensionExcludedByGroup('userId', 'model')).toBe(false);
  });

  it('normalizes an unavailable user grouping without retaining hidden filters', () => {
    expect(scopeTelemetryIdentity('userId', filters, false, 'model')).toEqual({
      groupBy: 'model',
      filters: { model: [], upstream: ['up-1'], userId: [], keyId: ['key-1'] },
    });
  });
});
