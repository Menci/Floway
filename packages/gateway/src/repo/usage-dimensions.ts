import type { UsageDimensionRecord, UsageRecord } from './types.ts';

export const usageDimensionRows = (record: UsageRecord): UsageDimensionRecord[] => record.dimensions.filter(row => row.quantity > 0);
