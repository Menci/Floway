import { computeAnthropicMessagesCountTokensUsage } from './compute-anthropic-messages-usage.ts';
import { computeGeminiGenerateContentCountTokensUsage } from './compute-gemini-generate-content-usage.ts';
import { discoverAnthropicMessagesCountTokensCandidates } from './discover-anthropic-messages.ts';
import { discoverGeminiGenerateContentCountTokensCandidates } from './discover-gemini-generate-content.ts';
import { encodeAnthropicMessagesCountTokens } from './encode-anthropic-messages.ts';
import { encodeGeminiGenerateContentCountTokens } from './encode-gemini-generate-content.ts';
import { compose } from './facts.ts';
import { failoverAnthropicMessagesCountTokens } from './failover-anthropic-messages.ts';
import { failoverGeminiGenerateContentCountTokens } from './failover-gemini-generate-content.ts';
import { measureAnthropicMessagesCountTokensPerformance } from './measure-anthropic-messages-performance.ts';
import { measureGeminiGenerateContentCountTokensPerformance } from './measure-gemini-generate-content-performance.ts';
import { parseAnthropicMessagesCountTokens } from './parse-anthropic-messages.ts';
import { parseGeminiGenerateContentCountTokens } from './parse-gemini-generate-content.ts';
import { prepareAnthropicMessagesCountTokens } from './prepare-anthropic-messages.ts';
import { anthropicMessagesCountTokensTargets, routeAnthropicMessagesCountTokensProvider } from './provider-anthropic-messages.ts';
import { geminiGenerateContentCountTokensTargets, routeGeminiGenerateContentCountTokensProvider } from './provider-gemini-generate-content.ts';
import { routeGeminiGenerateContentCountTokens } from './translate-gemini.ts';
import { stripAuthenticationHeaders } from '../../pipeline/auth-headers.ts';
import { httpEntry, httpExit } from '../shared/routing.ts';
import { asEntry } from '@floway-dev/pipeline';

const anthropicMessagesCountTokensEgressStages = [
  prepareAnthropicMessagesCountTokens,
  measureAnthropicMessagesCountTokensPerformance,
  computeAnthropicMessagesCountTokensUsage,
] as const;

const anthropicMessagesCountTokensEgress = compose('anthropicMessagesCountTokens.egress', {
  entry: ['http', 'upstream', 'model', 'aliasRules', 'anthropicMessagesCountTokens'],
  exit: ['http', 'anthropicMessagesCountTokens', 'usage?'],
  stages: anthropicMessagesCountTokensEgressStages,
  ending: routeAnthropicMessagesCountTokensProvider,
  targets: anthropicMessagesCountTokensTargets,
});

const geminiGenerateContentCountTokensEgress = compose('geminiGenerateContentCountTokens.egress', {
  entry: ['http', 'upstream', 'model', 'geminiGenerateContentCountTokens'],
  exit: ['http', 'geminiGenerateContentCountTokens', 'usage'],
  stages: [measureGeminiGenerateContentCountTokensPerformance, computeGeminiGenerateContentCountTokensUsage],
  ending: routeGeminiGenerateContentCountTokensProvider,
  targets: geminiGenerateContentCountTokensTargets,
});

export const anthropicMessagesCountTokensIngress = asEntry(compose('anthropicMessagesCountTokens.ingress', {
  entry: httpEntry,
  exit: httpExit,
  stages: [
    stripAuthenticationHeaders,
    parseAnthropicMessagesCountTokens,
    encodeAnthropicMessagesCountTokens,
    discoverAnthropicMessagesCountTokensCandidates,
    failoverAnthropicMessagesCountTokens,
    ...anthropicMessagesCountTokensEgressStages,
  ],
  ending: routeAnthropicMessagesCountTokensProvider,
  targets: anthropicMessagesCountTokensTargets,
}));

export const geminiGenerateContentCountTokensIngress = asEntry(compose('geminiGenerateContentCountTokens.ingress', {
  entry: httpEntry,
  exit: httpExit,
  stages: [
    stripAuthenticationHeaders,
    parseGeminiGenerateContentCountTokens,
    encodeGeminiGenerateContentCountTokens,
    discoverGeminiGenerateContentCountTokensCandidates,
    failoverGeminiGenerateContentCountTokens,
  ],
  ending: routeGeminiGenerateContentCountTokens,
  targets: { geminiGenerateContent: geminiGenerateContentCountTokensEgress, anthropicMessages: anthropicMessagesCountTokensEgress },
}));
