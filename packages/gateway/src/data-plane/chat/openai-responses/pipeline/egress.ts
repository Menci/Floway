import { applyOpenAIResponsesAliasRules } from './apply-alias-rules.ts';
import { normalizeOpenAIResponsesExclusiveCachedTokens } from './normalize-exclusive-cached-tokens.ts';
import { computeUsage, type UsageObserver } from '../../../pipeline/compute-usage.ts';
import { enterProvider } from '../../../pipeline/enter-provider.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { recordPerformance } from '../../../pipeline/performance.ts';
import type { StreamVerdict } from '../../../pipeline/protocol-outcome.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { storeUsage } from '../../../pipeline/store-usage.ts';
import { tokenUsageFromBillableUsage, tokenUsageMeasurement } from '../../../shared/telemetry/usage.ts';
import { chatEgress } from '../../pipeline/egress.ts';
import { chatBodyExit, chatEgressEntry } from '../../pipeline/topology.ts';
import { firstOutputTokenSignal } from '../../shared/first-output-token.ts';
import { billableUsageFromOpenAIResponsesEvent, billableUsageFromOpenAIResponsesResult } from '../usage.ts';
import { eventFrame, type BillableUsage } from '@floway-dev/protocols/common';
import { isOpenAIResponsesTerminalEvent, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const { compose } = gatewayFactSpace<GatewayServices>();

const protocol = 'openaiResponses';
const response = 'response.openaiResponses';

const measureUsage = (usage: BillableUsage | null) =>
  usage === null ? null : tokenUsageMeasurement(tokenUsageFromBillableUsage(usage));

const verdict = (event: OpenAIResponsesStreamEventEx): StreamVerdict | undefined => {
  if (event.type === 'error' || event.type === 'response.failed') return 'failure';
  return isOpenAIResponsesTerminalEvent(event) ? 'complete' : undefined;
};

const usage: UsageObserver<typeof response> = {
  kind: 'billable',
  result: result => measureUsage(billableUsageFromOpenAIResponsesResult(result)),
  stream() {
    let latest: BillableUsage | null = null;
    return {
      observe(event) {
        latest = billableUsageFromOpenAIResponsesEvent(event) ?? latest;
        return isOpenAIResponsesTerminalEvent(event) ? measureUsage(latest) : null;
      },
      finish: () => measureUsage(latest),
    };
  },
};

const normalizers = [normalizeOpenAIResponsesExclusiveCachedTokens, applyOpenAIResponsesAliasRules];

export const openAIResponsesEgress = compose('openaiResponses.egress', {
  entry: chatEgressEntry(protocol),
  exit: chatBodyExit(protocol),
  ...chatEgress(protocol, {
    usage,
    firstOutput: event => firstOutputTokenSignal(eventFrame(event), protocol) !== null,
    verdict,
    normalizers,
  }),
});

export const openAIResponsesCompactEgress = compose('openaiResponses.compact-egress', {
  entry: chatEgressEntry(protocol),
  exit: chatBodyExit(protocol),
  stages: [
    storeUsage,
    recordPerformance(response, { operation: 'chat', providerOperation: 'openaiResponsesCompact' }),
    computeUsage(response, usage, verdict),
    ...normalizers,
  ],
  ...enterProvider('openaiResponsesCompact'),
});
