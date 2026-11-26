import type { PerformanceDisplayRecord, PerformanceMetric, PerformanceOverviewResult, PerformanceSliceRecord } from '../../repo/types.ts';
import type { TelemetryOverviewSnapshot } from '../shared/telemetry-overview-types.ts';

export interface PerformanceSliceRow extends Omit<PerformanceSliceRecord, 'buckets'> {
  ttft: [edge: number, count: number][];
  tpot: [edge: number, count: number][];
}

export interface PerformanceSlice {
  bucket: string;
  start: string;
  end: string;
  rows: PerformanceSliceRow[];
  total?: PerformanceSliceRow;
  dimensionValues: PerformanceOverviewResult['dimensionValues'];
}

export interface PerformanceSlicesResponse extends TelemetryOverviewSnapshot<PerformanceSlice> {
  edges: Record<PerformanceMetric, [lower: number, upper: number | null][]>;
  globalSummary?: PerformanceDisplayRecord | null;
}
