import { emitGeminiGenerateContentTokenCount } from './count-tokens/emit.ts';
import type { GeminiGenerateContentCountTokensEntry, GeminiGenerateContentCountTokensExit } from './count-tokens/facts.ts';
import { serializeClientJson } from '../../pipeline/serialize-client-json.ts';
import { materializeAttempt } from '../materialize-attempt.ts';
import { resolveChatCandidates } from '../resolve-candidates.ts';
import { measureGeminiGenerateContentAsAnthropicMessages } from './count-tokens/measure-via-anthropic-messages.ts';
import { narrowing } from './count-tokens/target.ts';
import { stripSafetySettingsFromGeminiGenerateContent } from './strip-safety-settings.ts';
import { stripUnsupportedPartFieldsFromGeminiGenerateContent } from './strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromGeminiGenerateContent } from './strip-unsupported-tools.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { failover } from '../../pipeline/failover.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { anthropicMessagesCountTokensWire } from '../anthropic-messages/count-tokens/wire.ts';
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
      failed: handedUp => isFailure((handedUp as { 'response.chat.geminiGenerateContent'?: unknown })['response.chat.geminiGenerateContent']),
      owns: ['response.http.body'],
    }),
    materializeAttempt('request.chat.geminiGenerateContent'),
    stripUnsupportedPartFieldsFromGeminiGenerateContent,
    stripUnsupportedToolsFromGeminiGenerateContent,
    stripSafetySettingsFromGeminiGenerateContent,
    measureGeminiGenerateContentAsAnthropicMessages,
    ...anthropicMessagesCountTokensWire,
  ]);
