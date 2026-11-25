import { applyAliasRules } from './apply-alias-rules.ts';
import { normalizeExclusiveCachedTokens } from './normalize-exclusive-cached-tokens.ts';
import { normalizeUsage } from './normalize-usage.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { tokenUsageFromBillableUsage, tokenUsageMeasurement } from '../../../shared/telemetry/usage.ts';
import { chatEgress } from '../../pipeline/egress.ts';
import { chatBodyExit, chatEgressEntry } from '../../pipeline/topology.ts';
import { firstOutputTokenSignal } from '../../shared/first-output-token.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from '../usage.ts';
import { eventFrame, type BillableUsage } from '@floway-dev/protocols/common';
import { openaiChatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/openai-chat-completions';

const protocol = 'openaiChatCompletions';
const { compose } = gatewayFactSpace<GatewayServices>();

export const openAIChatCompletionsEgress = compose('openaiChatCompletions.egress', {
  entry: chatEgressEntry(protocol),
  exit: chatBodyExit(protocol),
  ...chatEgress(protocol, {
    usage: {
      kind: 'billable',
      stream: () => {
        let usage: BillableUsage | null = null;
        return {
          observe(event) {
            usage = billableUsageFromOpenAIChatCompletionsEvent(event) ?? usage;
            return null;
          },
          finish: () => usage === null ? null : tokenUsageMeasurement(tokenUsageFromBillableUsage(usage)),
        };
      },
    },
    firstOutput: event => firstOutputTokenSignal(eventFrame(event), protocol) !== null,
    verdict: event => openaiChatCompletionsErrorPayloadMessage(event) === null ? undefined : 'failure',
    normalizers: [normalizeUsage, normalizeExclusiveCachedTokens, applyAliasRules],
  }),
});
