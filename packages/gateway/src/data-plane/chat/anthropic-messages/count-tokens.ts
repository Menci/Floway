import { emitAnthropicMessagesTokenCount } from './count-tokens/emit.ts';
import type { AnthropicMessagesCountTokensEntry, AnthropicMessagesCountTokensExit } from './count-tokens/facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { materializeAttempt } from '../materialize-attempt.ts';
import { resolveChatCandidates } from '../resolve-candidates.ts';
import { narrowing } from './count-tokens/target.ts';
import { anthropicMessagesCountTokensWire } from './count-tokens/wire.ts';
import { failover } from '../../pipeline/failover.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const anthropicMessagesCountTokensPipeline = (payload: AnthropicMessagesPayload): Pipeline<AnthropicMessagesCountTokensEntry, AnthropicMessagesCountTokensExit> =>
  compose('anthropicMessagesCountTokens', [
    // A measurement goes through settlement like every other run. It provides an empty
    // billed set because nothing here is billable today, not because the operation is
    // exempt — an upstream that began charging for it would provide a non-empty one and
    // nothing else would change.
    writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400, undefined, false),
    emitAnthropicMessagesTokenCount,
    resolveChatCandidates(narrowing(payload)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.anthropicMessages'?: unknown })['response.chat.anthropicMessages']),
      owns: ['response.http.body'],
    }),
    materializeAttempt('request.chat.anthropicMessages'),
    ...anthropicMessagesCountTokensWire,
  ]);
