import { applyAliasRules } from './apply-alias-rules.ts';
import { verifyStreamCompletion } from './verify-stream-completion.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { tokenUsageFromBillableUsage, tokenUsageMeasurement } from '../../../shared/telemetry/usage.ts';
import { chatEgress } from '../../pipeline/egress.ts';
import { chatBodyExit, chatEgressEntry } from '../../pipeline/topology.ts';
import { firstOutputTokenSignal } from '../../shared/first-output-token.ts';
import { eventFrame, type BillableUsage } from '@floway-dev/protocols/common';
import { billableUsageFromGeminiGenerateContentEvent, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent } from '@floway-dev/protocols/gemini-generate-content';

const protocol = 'geminiGenerateContent';
const { compose } = gatewayFactSpace<GatewayServices>();

export const geminiGenerateContentEgress = compose('geminiGenerateContent.egress', {
  entry: chatEgressEntry(protocol),
  exit: chatBodyExit(protocol),
  ...chatEgress(protocol, {
    usage: {
      kind: 'billable',
      stream: () => {
        let usage: BillableUsage | null = null;
        return {
          observe(event) {
            usage = billableUsageFromGeminiGenerateContentEvent(event) ?? usage;
            return null;
          },
          finish: () => usage === null ? null : tokenUsageMeasurement(tokenUsageFromBillableUsage(usage)),
        };
      },
    },
    firstOutput: event => firstOutputTokenSignal(eventFrame(event), protocol) !== null,
    verdict: event => isGeminiGenerateContentErrorEvent(event) ? 'failure' : isGeminiGenerateContentTerminalEvent(event) ? 'complete' : undefined,
    normalizers: [verifyStreamCompletion, applyAliasRules],
  }),
});
