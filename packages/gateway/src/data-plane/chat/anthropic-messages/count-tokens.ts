import { materializeAttempt } from '../materialize-attempt.ts';
import { resolveChatCandidates } from '../resolve-candidates.ts';
import { emitAnthropicMessagesTokenCount } from './count-tokens/emit.ts';
import type { AnthropicMessagesCountTokensEntry, AnthropicMessagesCountTokensExit } from './count-tokens/facts.ts';
import { narrowing } from './count-tokens/target.ts';
import { anthropicMessagesCountTokensWire } from './count-tokens/wire.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { failover } from '../../pipeline/failover.ts';
import { serializeClientJson } from '../../pipeline/serialize-client-json.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';

export const anthropicMessagesCountTokensPipeline = (): Pipeline<AnthropicMessagesCountTokensEntry, AnthropicMessagesCountTokensExit> =>
  compose('anthropicMessagesCountTokens', [
    // Native counts measure a request without generating AI usage; a failed reply must
    // not recover a billable entity from the transport-call proof.
    writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400, undefined, false),
    serializeClientJson('response.chat.anthropicMessages.rendered'),
    emitAnthropicMessagesTokenCount,
    resolveChatCandidates(narrowing),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.anthropicMessages'?: unknown })['response.chat.anthropicMessages']),
      owns: ['response.http.body'],
    }),
    materializeAttempt('request.chat.anthropicMessages'),
    ...anthropicMessagesCountTokensWire,
  ]);
