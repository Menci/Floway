import { normalizeOpenAIResponsesCompactUsage } from './cached-token-usage.ts';
import { openAIResponsesCompactCollaboration } from './collaboration.ts';
import { openAIResponsesCompactHostedHistory } from './hosted-history.ts';
import { openAIResponsesCompactInputShims } from './input-shims.ts';
import { normalizeOpenAIResponsesCompact } from './normalize.ts';
import { computeUsage } from '../../../pipeline/compute-usage.ts';
import { compose } from '../../../pipeline/facts.ts';
import { measurePerformance } from '../../../pipeline/performance.ts';
import { providerTargets } from '../../../pipeline/provider-targets.ts';
import { storeUsage } from '../../../pipeline/store-usage.ts';
import { tokenUsageFromBillableUsage, tokenUsageMeasurement } from '../../../shared/telemetry/usage.ts';
import { billableUsageFromOpenAIResponsesResult } from '../usage.ts';
import type { UpstreamProviderKind } from '@floway-dev/provider';

const operation = 'openaiResponsesCompact';

export const nativeOpenAIResponsesCompactRequest = [
  'request.http',
  'request.auth.apiKeyId',
  'serve.runtimeLocation',
  'provider.upstream',
  'provider.model',
  'request.aliasRules?',
  'request.openaiResponsesCompact',
] as const;
export const nativeOpenAIResponsesCompactResponse = ['response.http', 'response.openaiResponsesCompact', 'response.usage', 'response.performance'] as const;

const { targets: nativeTargets, ending: nativeProvider } = providerTargets(operation);

export const openAIResponsesCompactEgress = compose('openaiResponsesCompact.egress', {
  entry: nativeOpenAIResponsesCompactRequest,
  exit: nativeOpenAIResponsesCompactResponse,
  stages: [
    measurePerformance(operation, 'chat'),
    storeUsage,
    computeUsage(operation, {
      result: result => [tokenUsageMeasurement(tokenUsageFromBillableUsage(billableUsageFromOpenAIResponsesResult(result) ?? undefined))],
    }),
    openAIResponsesCompactInputShims,
    openAIResponsesCompactCollaboration,
    openAIResponsesCompactHostedHistory,
    normalizeOpenAIResponsesCompact,
    normalizeOpenAIResponsesCompactUsage,
  ],
  ending: nativeProvider,
  targets: nativeTargets,
});

export const hasNativeOpenAIResponsesCompactTarget = (kind: UpstreamProviderKind): boolean => Object.hasOwn(nativeTargets, kind);
