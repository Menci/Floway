import { tokenUsage } from '../../shared/telemetry/usage.ts';
import type { BillableUsage } from '@floway-dev/protocols/common';

// `BillableUsage` is already the canonical exclusive/split shape, so pricing is
// a rename rather than a computation. It is the sole input: the usage Floway
// sends the client is a wire projection and is never read here.
export const tokenUsageFromBillableUsage = (billable: BillableUsage | undefined) =>
  billable === undefined ? null : tokenUsage({
    input: billable.input,
    input_cache_read: billable.cacheRead,
    input_cache_write: billable.cacheWrite,
    input_cache_write_1h: billable.cacheWrite1h,
    output: billable.output,
    ...(billable.tier !== undefined ? { tier: billable.tier } : {}),
  });
