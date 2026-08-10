import type { ResponsesInterceptor } from './types.ts';
import { meteringBillableUsage } from '../../shared/billable-usage-meter.ts';
import { billableUsageFromResponsesEvent } from '../usage.ts';

export const withBillableUsageMetered: ResponsesInterceptor = meteringBillableUsage(
  'responses',
  () => billableUsageFromResponsesEvent,
);
