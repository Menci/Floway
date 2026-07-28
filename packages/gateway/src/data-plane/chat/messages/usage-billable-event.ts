import { billableUsageFromMessagesUsage } from './usage-billable.ts';
import type { BillableUsage } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent, MessagesUsageSnapshot } from '@floway-dev/protocols/messages';

// Anthropic reports input accounting on `message_start` and output accounting
// on `message_delta`, so the running figure is merged across both.
export const createMessagesBillableUsageReader = (): (event: MessagesStreamEvent) => BillableUsage | null => {
  let merged: Partial<MessagesUsageSnapshot> = {};
  return event => {
    const usage = event.type === 'message_start' ? event.message.usage
      : event.type === 'message_delta' ? event.usage
        : undefined;
    if (!usage) return null;
    merged = { ...merged, ...usage };
    return billableUsageFromMessagesUsage(merged as MessagesUsageSnapshot);
  };
};
