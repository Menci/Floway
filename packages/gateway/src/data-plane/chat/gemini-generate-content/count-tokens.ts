import { emitGeminiGenerateContentTokenCount } from './count-tokens/emit.ts';
import type { GeminiGenerateContentCountTokensEntry, GeminiGenerateContentCountTokensExit } from './count-tokens/facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { materializeAttempt } from '../materialize-attempt.ts';
import { resolveChatCandidates } from '../resolve-candidates.ts';
import { measureGeminiGenerateContentAsAnthropicMessages } from './count-tokens/measure-via-anthropic-messages.ts';
import { narrowing } from './count-tokens/target.ts';
import { stripSafetySettingsFromGeminiGenerateContent } from './strip-safety-settings.ts';
import { stripUnsupportedPartFieldsFromGeminiGenerateContent } from './strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromGeminiGenerateContent } from './strip-unsupported-tools.ts';
import { failover } from '../../pipeline/failover.ts';
import { anthropicMessagesCountTokensWire } from '../anthropic-messages/count-tokens/wire.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

export const geminiGenerateContentCountTokensPipeline = (payload: GeminiGenerateContentPayload): Pipeline<GeminiGenerateContentCountTokensEntry, GeminiGenerateContentCountTokensExit> =>
  compose('geminiGenerateContentCountTokens', [
    // A measurement goes through settlement like every other run. It provides an empty
    // billed set because nothing here is billable today, not because the operation is
    // exempt — an upstream that began charging for it would provide a non-empty one and
    // nothing else would change.
    writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400, undefined, false),
    emitGeminiGenerateContentTokenCount,
    resolveChatCandidates(narrowing(payload)),
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
