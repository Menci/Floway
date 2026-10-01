import { STREAMED_USAGE, type OpenAIChatCompletionsServeEntry, type OpenAIChatCompletionsServeExit } from './facts.ts';
import { composeChat as compose } from '../compose.ts';
import { emitOpenAIChatCompletions } from './emit.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { resolveChatCandidates } from '../resolve-candidates.ts';
import { narrowing, openaiChatCompletionsTarget } from './target.ts';
import { failover } from '../../pipeline/failover.ts';
import { materializeAttempt } from '../materialize-attempt.ts';
import { normalizeEmptyToolsForOpenAIChatCompletions } from './normalize-empty-tools-tool-choice.ts';
import { dialChatWire } from '../dial-wire.ts';
import { openaiChatCompletionsWireFor } from './wires.ts';
import type { Pipeline } from '@floway-dev/pipeline';

export const openaiChatCompletionsServePipeline = (): Pipeline<OpenAIChatCompletionsServeEntry, OpenAIChatCompletionsServeExit> =>
  compose('openaiChatCompletionsServe', [
    writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400, STREAMED_USAGE),
    emitOpenAIChatCompletions,
    resolveChatCandidates(narrowing),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.openaiChatCompletions'?: unknown })['response.chat.openaiChatCompletions']),
      owns: ['response.http.body'],
      pendingUsage: STREAMED_USAGE,
    }),
    materializeAttempt('request.chat.openaiChatCompletions'),
    normalizeEmptyToolsForOpenAIChatCompletions,
    dialChatWire({
      source: 'request.chat.openaiChatCompletions',
      needs: ['request.chat.openaiChatCompletions', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      provides: ['response.chat.openaiChatCompletions', STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
      pick: endpoints => openaiChatCompletionsTarget.pick(endpoints),
      wire: openaiChatCompletionsWireFor,
    }),
  ]);
