import type { StreamUsage } from '../../pipeline/compute-usage.ts';
import { requestOnlyUsageMeasurement, tokenUsageFromBillableUsage, tokenUsageMeasurement, type UsageMeasurement } from '../../shared/telemetry/usage.ts';
import type { BillableUsage } from '@floway-dev/protocols/common';
import type { ProtocolStreamError } from '@floway-dev/upstream';

export const chatUsageReader = <Event>(
  open: () => (event: Event) => BillableUsage | null,
  isComplete: (event: Event) => boolean,
  decodeErrorEvent?: (error: ProtocolStreamError) => Event | undefined,
): (() => StreamUsage<Event>) => () => {
  const read = open();
  let latest: readonly UsageMeasurement[] | undefined;
  const observe = (event: Event): void => {
    const usage = read(event);
    if (usage !== null) latest = [tokenUsageMeasurement(tokenUsageFromBillableUsage(usage))];
  };
  return {
    frame(event) {
      observe(event);
      return isComplete(event) ? latest : undefined;
    },
    done: () => latest ?? [requestOnlyUsageMeasurement()],
    error(error) {
      const event = decodeErrorEvent?.(error);
      if (event !== undefined) observe(event);
      return latest;
    },
  };
};
