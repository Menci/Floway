import { emitGeminiGenerateContentTokenCount } from './count-tokens/emit.ts';
import type { GeminiGenerateContentCountTokensEntry, GeminiGenerateContentCountTokensExit } from './count-tokens/facts.ts';
import { serializeClientJson } from '../../pipeline/serialize-client-json.ts';
import { materializeAttempt } from '../materialize-attempt.ts';
import { resolveChatCandidates } from '../resolve-candidates.ts';
import { measureGeminiGenerateContentAsAnthropicMessages } from './count-tokens/measure-via-anthropic-messages.ts';
import { geminiGenerateContentCountTokensTarget, narrowing } from './count-tokens/target.ts';
import { callGeminiGenerateContentUpstream } from './call-upstream.ts';
import { shapeGeminiGenerateContentForTranslation } from './wires.ts';
import { failover } from '../../pipeline/failover.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { anthropicMessagesCountTokensWire } from '../anthropic-messages/count-tokens/wire.ts';
import { dialChatWire } from '../dial-wire.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';

export const geminiGenerateContentCountTokensPipeline = (): Pipeline<GeminiGenerateContentCountTokensEntry, GeminiGenerateContentCountTokensExit> =>
  compose('geminiGenerateContentCountTokens', [
    // Native counts measure a request without generating AI usage; a failed reply must
    // not recover a billable entity from the transport-call proof.
    writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400, undefined, false),
    serializeClientJson('response.chat.geminiGenerateContent.rendered'),
    emitGeminiGenerateContentTokenCount,
    resolveChatCandidates(narrowing),
    failover({
      answer: handedUp => handedUp['response.chat.geminiGenerateContent'],
      owns: ['response.http.body'],
    }),
    materializeAttempt('request.chat.geminiGenerateContent'),
    dialChatWire({
      source: 'request.chat.geminiGenerateContent',
      needs: ['request.chat.geminiGenerateContent', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      provides: ['response.chat.geminiGenerateContent', 'response.usage.billable', 'response.http.headers'],
      pick: geminiGenerateContentCountTokensTarget.pick,
      wire: target => target === 'geminiGenerateContent'
        ? compose('geminiGenerateContentCountTokensNative', [callGeminiGenerateContentUpstream('geminiGenerateContentCountTokens')])
        : compose('geminiGenerateContentCountTokensViaAnthropicMessages', [
          ...shapeGeminiGenerateContentForTranslation, measureGeminiGenerateContentAsAnthropicMessages, ...anthropicMessagesCountTokensWire,
        ]),
    }),
  ]);
