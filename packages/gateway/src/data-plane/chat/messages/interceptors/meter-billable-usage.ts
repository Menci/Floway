import type { MessagesInterceptor } from './types.ts';
import { meteringBillableUsage } from '../../shared/billable-usage-meter.ts';
import { createMessagesBillableUsageReader } from '../usage.ts';

export const withBillableUsageMetered: MessagesInterceptor = meteringBillableUsage(
  'messages',
  createMessagesBillableUsageReader,
);
