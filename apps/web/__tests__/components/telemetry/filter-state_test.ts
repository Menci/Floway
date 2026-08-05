import { describe, expect, it } from 'vitest';

import { changeTelemetryFilter, changeTelemetryGroupBy, clearGroupedTelemetryFilters, scopeTelemetryIdentity, telemetryDimensionExcludedByGroup } from '../../../src/components/telemetry/filter-state';

const filters = { model: ['gpt-5'], upstream: ['up-1'], userId: ['2'], keyId: ['key-1'] };
const context = { currentUserId: '1', fallbackGroup: 'model' as const, userDimensionAvailable: true };

describe('telemetry filter state', () => {
  it('clears the active shared dimension and hides API key filters under user grouping', () => {
    expect(clearGroupedTelemetryFilters(filters, 'upstream')).toEqual({ ...filters, upstream: [] });
    expect(clearGroupedTelemetryFilters(filters, 'userId')).toEqual({ ...filters, userId: [], keyId: [] });
    expect(clearGroupedTelemetryFilters(filters, 'keyId')).toEqual({ ...filters, keyId: [] });
  });

  it('keeps the effective user scope visible under API key grouping', () => {
    expect(telemetryDimensionExcludedByGroup('model', 'model')).toBe(true);
    expect(telemetryDimensionExcludedByGroup('userId', 'keyId')).toBe(true);
    expect(telemetryDimensionExcludedByGroup('keyId', 'userId')).toBe(false);
    expect(telemetryDimensionExcludedByGroup('userId', 'model')).toBe(false);
  });

  it('normalizes an unavailable user grouping without retaining hidden filters', () => {
    expect(scopeTelemetryIdentity('userId', filters, { ...context, userDimensionAvailable: false })).toEqual({
      groupBy: 'model',
      filters: { model: [], upstream: ['up-1'], userId: [], keyId: [] },
    });
  });

  it('sets API key grouping and filtering to the current user scope', () => {
    expect(changeTelemetryGroupBy({ groupBy: 'model', filters }, 'keyId', context)).toEqual({
      groupBy: 'keyId',
      filters: { model: ['gpt-5'], upstream: ['up-1'], userId: ['1'], keyId: [] },
    });
    expect(changeTelemetryFilter({ groupBy: 'model', filters: { ...filters, userId: ['2'], keyId: [] } }, 'keyId', ['key-2'], context)).toEqual({
      groupBy: 'model',
      filters: { model: [], upstream: ['up-1'], userId: ['1'], keyId: ['key-2'] },
    });
  });

  it('normalizes active filters when state is restored directly from an address', () => {
    expect(scopeTelemetryIdentity('userId', filters, context)).toEqual({
      groupBy: 'userId',
      filters: { model: ['gpt-5'], upstream: ['up-1'], userId: [], keyId: [] },
    });
  });

  it('leaves API key grouping and clears key filters when another user is selected', () => {
    expect(changeTelemetryFilter({
      groupBy: 'keyId',
      filters: { ...filters, userId: ['1'], keyId: [] },
    }, 'userId', ['2'], context)).toEqual({
      groupBy: 'model',
      filters: { model: [], upstream: ['up-1'], userId: ['2'], keyId: [] },
    });
  });
});
