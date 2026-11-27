import { geminiGenerateContentAffinityOutput } from './affinity-output.ts';
import { geminiGenerateContentBody } from './body.ts';
import { buildGeminiGenerateContentAttemptTargets } from './build-attempt-targets.ts';
import { collectGeminiGenerateContent } from './collect.ts';
import { encodeGeminiGenerateContent } from './encode.ts';
import { enterGeminiGenerateContentBody } from './enter-body.ts';
import { failoverGeminiGenerateContent } from './failover.ts';
import { parseGeminiGenerateContent } from './parse.ts';
import { discoverChatCandidates } from '../../pipeline/discover-chat-candidates.ts';
import { compose } from '../../pipeline/facts.ts';
import { asEntry } from '@floway-dev/pipeline';

const stages = [
  discoverChatCandidates,
  buildGeminiGenerateContentAttemptTargets,
  failoverGeminiGenerateContent,
  geminiGenerateContentAffinityOutput,
] as const;

export const geminiGenerateContentHttpEntry = asEntry(compose('geminiGenerateContent.http', {
  entry: ['http', 'serve.startedAt'],
  exit: ['http', 'usage?', 'candidate?'],
  stages: [parseGeminiGenerateContent, encodeGeminiGenerateContent, collectGeminiGenerateContent, ...stages],
  ending: enterGeminiGenerateContentBody,
  targets: { body: geminiGenerateContentBody },
}));
