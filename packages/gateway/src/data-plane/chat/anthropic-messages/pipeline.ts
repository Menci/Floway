import { STREAMED_USAGE, type AnthropicMessagesServeEntry, type AnthropicMessagesServeExit } from './facts.ts';
import { composeChat as compose } from '../compose.ts';
import { answerClaudeCodeProbe } from './answer-claude-code-probe.ts';
import { emitAnthropicMessages } from './emit.ts';
import { normalizeEmptyToolsForAnthropicMessages } from './normalize-empty-tools-tool-choice.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { resolveChatCandidates } from '../resolve-candidates.ts';
import { narrowing, anthropicMessagesTarget } from './target.ts';
import { failover } from '../../pipeline/failover.ts';
import { materializeAttempt } from '../materialize-attempt.ts';
import { runAnthropicMessagesWebSearchTool } from './web-search-tool.ts';
import { dialChatWire } from '../dial-wire.ts';
import { anthropicMessagesWireFor } from './wires.ts';
import type { Pipeline } from '@floway-dev/pipeline';

export const anthropicMessagesServePipeline = (): Pipeline<AnthropicMessagesServeEntry, AnthropicMessagesServeExit> =>
  compose('anthropicMessagesServe', [
    writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400, STREAMED_USAGE),
    emitAnthropicMessages,
    resolveChatCandidates(narrowing),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.anthropicMessages'?: unknown })['response.chat.anthropicMessages']),
      owns: ['response.http.body'],
      pendingUsage: STREAMED_USAGE,
    }),
    materializeAttempt('request.chat.anthropicMessages'),
    answerClaudeCodeProbe,
    // Below the probe, because a probe turn declares no tools; above the dial, because what it
    // rewrites is the body that dial sends and the frames that dial hands back.
    runAnthropicMessagesWebSearchTool({ targetOf: candidate => anthropicMessagesTarget.pick(candidate.model.endpoints) }),
    normalizeEmptyToolsForAnthropicMessages,
    dialChatWire({
      source: 'request.chat.anthropicMessages',
      needs: ['request.chat.anthropicMessages', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      provides: ['response.chat.anthropicMessages', STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
      pick: endpoints => anthropicMessagesTarget.pick(endpoints),
      wire: anthropicMessagesWireFor,
    }),
  ]);
