import type { ChatCompletionsInterceptor } from './types.ts';
import { meteringBillableUsage } from '../../shared/billable-usage-meter.ts';
import { billableUsageFromChatCompletionsEvent } from '../usage.ts';

export const withBillableUsageMetered: ChatCompletionsInterceptor = meteringBillableUsage(
  'chat-completions',
  () => billableUsageFromChatCompletionsEvent,
);
