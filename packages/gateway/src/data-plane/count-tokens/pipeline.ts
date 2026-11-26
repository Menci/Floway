import { buildAnthropicMessagesCountTokensAttemptTargets, buildGeminiGenerateContentCountTokensAttemptTargets } from './affinity.ts';
import { encodeAnthropicMessagesCountTokens, encodeGeminiGenerateContentCountTokens } from './encode.ts';
import { parseAnthropicMessagesCountTokens } from './parse-anthropic-messages.ts';
import { parseGeminiGenerateContentCountTokens } from './parse-gemini-generate-content.ts';
import { prepareAnthropicMessagesCountTokens } from './prepare-anthropic-messages.ts';
import { translateGeminiCountTokens } from './translate-gemini.ts';
import { geminiGenerateContentRpcErrorPayload } from '../chat/gemini-generate-content/errors.ts';
import { stripAuthenticationHeaders } from '../pipeline/auth-headers.ts';
import { computeUsage } from '../pipeline/compute-usage.ts';
import { discoverCandidates } from '../pipeline/discover-candidates.ts';
import { localResponseHead } from '../pipeline/encode.ts';
import { compose } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { measurePerformance } from '../pipeline/performance.ts';
import { providerTargets } from '../pipeline/provider-targets.ts';
import { storeUsage } from '../pipeline/store-usage.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { generateAnthropicId } from '@floway-dev/protocols/anthropic-messages';

const httpEntry = [
  'request.http',
  'request.auth.apiKeyId',
  'request.auth.userId',
  'request.auth.isAdmin',
  'request.auth.upstreamIds',
  'request.auth.randomizeUpstreams',
  'serve.runtimeLocation',
] as const;
const httpExit = ['response.http', 'response.candidate?', 'response.usage?', 'response.performance?', 'response.outcome', 'response.requestedModel?'] as const;
const providerEntry = [
  'request.http',
  'request.auth.apiKeyId',
  'serve.runtimeLocation',
  'provider.upstream',
  'provider.model',
] as const;

const anthropic = 'anthropicMessagesCountTokens';
const gemini = 'geminiGenerateContentCountTokens';
const anthropicStages = [
  prepareAnthropicMessagesCountTokens,
  measurePerformance(anthropic, 'count_tokens'),
  storeUsage,
  computeUsage(anthropic, { result: () => [] }),
] as const;

const anthropicMessagesCountTokensEgress = compose(`${anthropic}.egress`, {
  entry: [...providerEntry, 'request.aliasRules?', 'request.anthropicMessagesCountTokens'],
  exit: ['response.http', 'response.anthropicMessagesCountTokens', 'response.usage?', 'response.performance?'],
  stages: anthropicStages,
  ...providerTargets(anthropic),
});

const geminiGenerateContentCountTokensEgress = compose(`${gemini}.egress`, {
  entry: [...providerEntry, 'request.geminiGenerateContentCountTokens'],
  exit: ['response.http', 'response.geminiGenerateContentCountTokens', 'response.usage', 'response.performance'],
  stages: [
    measurePerformance(gemini, 'count_tokens'),
    storeUsage,
    computeUsage(gemini, { result: () => [] }),
  ],
  ...providerTargets(gemini),
});

export const anthropicMessagesCountTokensPipeline = compose(anthropic, {
  entry: httpEntry,
  exit: httpExit,
  stages: [
    stripAuthenticationHeaders,
    parseAnthropicMessagesCountTokens,
    encodeAnthropicMessagesCountTokens,
    discoverCandidates(anthropic, {
      kind: 'chat',
      model: payload => payload.model,
      supports: model => model.endpoints.anthropicMessages !== undefined,
      unavailable({ model, exists, failedUpstreams }) {
        const message = exists
          ? `Model ${model} does not support the /messages/count_tokens endpoint.`
          : `Model ${model} is not available on any configured upstream.`;
        return {
          http: { ...localResponseHead(exists ? 400 : 404), body: null },
          outcome: {
            kind: 'error',
            source: 'local',
            error: {
              type: 'error',
              error: { type: exists ? 'invalid_request_error' : 'not_found_error', message: appendFailedUpstreams(message, failedUpstreams) },
              request_id: generateAnthropicId('req'),
            },
          },
        };
      },
    }),
    buildAnthropicMessagesCountTokensAttemptTargets,
    failover(anthropic, undefined, { attemptTargets: true }),
    ...anthropicStages,
  ],
  ...providerTargets(anthropic),
});

export const geminiGenerateContentCountTokensPipeline = compose(gemini, {
  entry: httpEntry,
  exit: httpExit,
  stages: [
    stripAuthenticationHeaders,
    parseGeminiGenerateContentCountTokens,
    encodeGeminiGenerateContentCountTokens,
    discoverCandidates(gemini, {
      kind: 'chat',
      model: 'request.model',
      supports: model => model.endpoints.geminiGenerateContent !== undefined || model.endpoints.anthropicMessages !== undefined,
      unavailable({ model, exists, failedUpstreams }) {
        const status = exists ? 400 : 404;
        const message = exists
          ? `Model ${model} does not support countTokens.`
          : `Model ${model} is not available on any configured upstream.`;
        return {
          http: { ...localResponseHead(status), body: null },
          outcome: { kind: 'error', source: 'local', error: geminiGenerateContentRpcErrorPayload(status, appendFailedUpstreams(message, failedUpstreams)) },
        };
      },
    }),
    buildGeminiGenerateContentCountTokensAttemptTargets,
    failover(gemini, undefined, { attemptTargets: true }),
  ],
  ending: translateGeminiCountTokens,
  targets: {
    geminiGenerateContent: geminiGenerateContentCountTokensEgress,
    anthropicMessages: anthropicMessagesCountTokensEgress,
  },
});
