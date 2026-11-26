import { openAIResponsesCompactAffinityOutput } from './affinity-output.ts';
import { openAIResponsesCompactClientOutput } from './client-output.ts';
import { dispatchOpenAIResponsesCompact } from './dispatch.ts';
import { openAIResponsesCompactEgress } from './egress.ts';
import { encodeOpenAIResponsesCompact } from './encode.ts';
import { parseOpenAIResponsesCompact } from './parse.ts';
import { stripAuthenticationHeaders } from '../../../pipeline/auth-headers.ts';
import { discoverCandidates } from '../../../pipeline/discover-candidates.ts';
import { compose } from '../../../pipeline/facts.ts';
import { failover } from '../../../pipeline/failover.ts';
import { chatBodies } from '../../pipeline.ts';
import { buildAttemptTargets } from '../../shared/affinity/attempt-targets.ts';
import { analyzeOpenAIResponsesAffinity } from '../affinity/ingress.ts';
import { openAIResponsesChat } from '../pipeline-stages.ts';

const operation = 'openaiResponsesCompact';

export const openAIResponsesCompactIngress = compose('openaiResponsesCompact.ingress', {
  entry: [
    'request.http',
    'request.auth.apiKeyId',
    'request.auth.userId',
    'request.auth.isAdmin',
    'request.auth.upstreamIds',
    'request.auth.randomizeUpstreams',
    'serve.startedAt',
    'serve.runtimeLocation',
  ],
  exit: ['response.http', 'response.outcome', 'response.candidate?', 'response.requestedModel?', 'response.usage?', 'response.performance?'],
  stages: [
    stripAuthenticationHeaders,
    parseOpenAIResponsesCompact,
    encodeOpenAIResponsesCompact,
    openAIResponsesCompactClientOutput,
    discoverCandidates(operation, {
      kind: 'chat',
      model: payload => payload.model,
      supports: ({ endpoints }) => endpoints.openaiResponses !== undefined
        || endpoints.anthropicMessages !== undefined || endpoints.openaiChatCompletions !== undefined,
      unavailable: openAIResponsesChat.unavailable,
    }),
    buildAttemptTargets(operation, analyzeOpenAIResponsesAffinity, openAIResponsesChat.affinityUnavailable),
    failover(operation, undefined, { attemptTargets: true }),
    openAIResponsesCompactAffinityOutput,
  ],
  ending: dispatchOpenAIResponsesCompact,
  targets: { native: openAIResponsesCompactEgress, generate: chatBodies.openaiResponses },
});
