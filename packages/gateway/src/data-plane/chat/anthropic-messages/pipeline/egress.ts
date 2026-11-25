import { applyAliasRules } from './apply-alias-rules.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { tokenUsageFromBillableUsage, tokenUsageMeasurement } from '../../../shared/telemetry/usage.ts';
import { chatEgress } from '../../pipeline/egress.ts';
import { chatBodyExit, chatEgressEntry } from '../../pipeline/topology.ts';
import { firstOutputTokenSignal } from '../../shared/first-output-token.ts';
import { createAnthropicMessagesBillableUsageReader } from '../usage.ts';
import { eventFrame, type BillableUsage } from '@floway-dev/protocols/common';

const protocol = 'anthropicMessages';
const { compose } = gatewayFactSpace<GatewayServices>();

export const anthropicMessagesEgress = compose('anthropicMessages.egress', {
  entry: chatEgressEntry(protocol),
  exit: chatBodyExit(protocol),
  ...chatEgress(protocol, {
    usage: {
      kind: 'billable',
      stream: () => {
        const read = createAnthropicMessagesBillableUsageReader();
        let usage: BillableUsage | null = null;
        return {
          observe(event) {
            usage = read(event) ?? usage;
            return null;
          },
          finish: () => usage === null ? null : tokenUsageMeasurement(tokenUsageFromBillableUsage(usage)),
        };
      },
    },
    firstOutput: event => firstOutputTokenSignal(eventFrame(event), protocol) !== null,
    verdict: event => event.type === 'error' ? 'failure' : event.type === 'message_stop' ? 'complete' : undefined,
    normalizers: [applyAliasRules],
  }),
});
