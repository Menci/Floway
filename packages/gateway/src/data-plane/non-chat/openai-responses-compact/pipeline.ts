import { wrapOpenAIResponsesCompactAffinity } from './affinity-output.ts';
import { openAIResponsesCompactClientOutput } from './client-output.ts';
import { applyOpenAIResponsesCompactCollaboration } from './collaboration.ts';
import { computeOpenAIResponsesCompactUsage } from './compute-usage.ts';
import { discoverOpenAIResponsesCompactCandidates } from './discover-candidates.ts';
import { dispatchOpenAIResponsesCompact, nativeOpenAIResponsesCompactRequest, nativeOpenAIResponsesCompactResponse } from './dispatch.ts';
import { encodeOpenAIResponsesCompact } from './encode.ts';
import { compose } from './facts.ts';
import { failoverOpenAIResponsesCompact } from './failover.ts';
import { prepareOpenAIResponsesCompactHostedHistory } from './hosted-history.ts';
import { normalizeOpenAIResponsesCompactUsage } from './normalize-usage.ts';
import { normalizeOpenAIResponsesCompactRequest } from './normalize.ts';
import { parseOpenAIResponsesCompact } from './parse.ts';
import { measureOpenAIResponsesCompactPerformance } from './performance.ts';
import { prepareNativeOpenAIResponsesCompact } from './prepare-native.ts';
import { openaiResponsesCompactTargets, routeOpenAIResponsesCompactProvider } from './providers.ts';
import { openaiResponsesBody } from '../../chat/openai-responses/pipeline/body.ts';
import { stripAuthenticationHeaders } from '../../pipeline/auth-headers.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';
import { httpEntry, httpExit } from '../shared/routing.ts';
import { asEntry } from '@floway-dev/pipeline';

export const openaiResponsesCompactEgress = compose('openaiResponsesCompact.egress', {
  entry: nativeOpenAIResponsesCompactRequest,
  exit: nativeOpenAIResponsesCompactResponse,
  stages: [
    prepareNativeOpenAIResponsesCompact,
    applyOpenAIResponsesCompactCollaboration,
    prepareOpenAIResponsesCompactHostedHistory,
    measureOpenAIResponsesCompactPerformance,
    storeUsage,
    computeOpenAIResponsesCompactUsage,
    normalizeOpenAIResponsesCompactRequest,
    normalizeOpenAIResponsesCompactUsage,
  ],
  ending: routeOpenAIResponsesCompactProvider,
  targets: openaiResponsesCompactTargets,
});

export const openaiResponsesCompactIngress = asEntry(compose('openaiResponsesCompact.ingress', {
  entry: httpEntry,
  exit: httpExit,
  stages: [
    stripAuthenticationHeaders,
    parseOpenAIResponsesCompact,
    encodeOpenAIResponsesCompact,
    openAIResponsesCompactClientOutput,
    discoverOpenAIResponsesCompactCandidates,
    failoverOpenAIResponsesCompact,
    wrapOpenAIResponsesCompactAffinity,
  ],
  ending: dispatchOpenAIResponsesCompact,
  targets: { native: openaiResponsesCompactEgress, generate: () => openaiResponsesBody },
}));
