import type { StreamUsage } from '../../pipeline/compute-usage.ts';
import { requestOnlyUsageMeasurement, tokenUsageFromBillableUsage, tokenUsageMeasurement, type UsageMeasurement } from '../../shared/telemetry/usage.ts';
import type { BillableUsage } from '@floway-dev/protocols/common';
import type { ProtocolStreamError } from '@floway-dev/provider';

export const chatTokenUsage = <Event>(
  createReader: () => (event: Event) => BillableUsage | null,
  isFinal?: (event: Event) => boolean,
  readErrorEvent?: (error: ProtocolStreamError) => Event | undefined,
): (() => StreamUsage<Event>) => () => {
  const read = createReader();
  let latest: readonly UsageMeasurement[] | undefined;
  const observe = (event: Event): void => {
    const usage = read(event);
    if (usage !== null) latest = [tokenUsageMeasurement(tokenUsageFromBillableUsage(usage))];
  };
  return {
    frame(event) {
      observe(event);
      return isFinal === undefined || isFinal(event) ? latest : undefined;
    },
    done: () => latest ?? [requestOnlyUsageMeasurement()],
    error(error) {
      const event = readErrorEvent === undefined
        ? error.kind === 'protocol' ? error.event as unknown as Event | undefined : undefined
        : readErrorEvent(error);
      if (event !== undefined) observe(event);
      return latest;
    },
  };
};
