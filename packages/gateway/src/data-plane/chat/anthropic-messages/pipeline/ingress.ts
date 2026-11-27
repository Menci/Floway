import { anthropicMessagesAffinityOutput } from './affinity-output.ts';
import { anthropicMessagesBody } from './body.ts';
import { buildAnthropicMessagesAttemptTargets } from './build-attempt-targets.ts';
import { collectAnthropicMessages } from './collect.ts';
import { encodeAnthropicMessages } from './encode.ts';
import { enterAnthropicMessagesBody } from './enter-body.ts';
import { failoverAnthropicMessages } from './failover.ts';
import { parseAnthropicMessages } from './parse.ts';
import { serializeAnthropicMessagesItems } from './serialize-stream-items.ts';
import { discoverChatCandidates } from '../../pipeline/discover-chat-candidates.ts';
import { compose } from '../../pipeline/facts.ts';
import { asEntry } from '@floway-dev/pipeline';

const stages = [
  discoverChatCandidates,
  buildAnthropicMessagesAttemptTargets,
  failoverAnthropicMessages,
  serializeAnthropicMessagesItems,
  anthropicMessagesAffinityOutput,
] as const;

export const anthropicMessagesHttpEntry = asEntry(compose('anthropicMessages.http', {
  entry: ['http', 'serve.startedAt'],
  exit: ['http', 'usage?', 'candidate?'],
  stages: [parseAnthropicMessages, encodeAnthropicMessages, collectAnthropicMessages, ...stages],
  ending: enterAnthropicMessagesBody,
  targets: { body: anthropicMessagesBody },
}));
