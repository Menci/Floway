import { openaiChatCompletionsAffinityOutput } from './affinity-output.ts';
import { openaiChatCompletionsBody } from './body.ts';
import { buildOpenAIChatCompletionsAttemptTargets } from './build-attempt-targets.ts';
import { collectOpenAIChatCompletions } from './collect.ts';
import { encodeOpenAIChatCompletions } from './encode.ts';
import { enterOpenAIChatCompletionsBody } from './enter-body.ts';
import { failoverOpenAIChatCompletions } from './failover.ts';
import { parseOpenAIChatCompletions } from './parse.ts';
import { discoverChatCandidates } from '../../pipeline/discover-chat-candidates.ts';
import { compose } from '../../pipeline/facts.ts';
import { asEntry } from '@floway-dev/pipeline';

const stages = [
  discoverChatCandidates,
  buildOpenAIChatCompletionsAttemptTargets,
  failoverOpenAIChatCompletions,
  openaiChatCompletionsAffinityOutput,
] as const;

export const openaiChatCompletionsHttpEntry = asEntry(compose('openaiChatCompletions.http', {
  entry: ['http', 'serve.startedAt'],
  exit: ['http', 'usage?', 'candidate?'],
  stages: [parseOpenAIChatCompletions, encodeOpenAIChatCompletions, collectOpenAIChatCompletions, ...stages],
  ending: enterOpenAIChatCompletionsBody,
  targets: { body: openaiChatCompletionsBody },
}));
