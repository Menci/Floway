import { STREAMED_USAGE, type GeminiGenerateContentServeEntry, type GeminiGenerateContentServeExit } from './facts.ts';
import { composeChat as compose } from '../compose.ts';
import { emitGeminiGenerateContent } from './emit.ts';
import { suppressThoughtPartsFromGeminiGenerateContent } from './suppress-thought-parts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { resolveChatCandidates } from '../resolve-candidates.ts';
import { requireGeminiGenerateContentTerminal } from './require-terminal.ts';
import { narrowing, geminiGenerateContentTarget } from './target.ts';
import { failover } from '../../pipeline/failover.ts';
import { materializeAttempt } from '../materialize-attempt.ts';
import { stripSafetySettingsFromGeminiGenerateContent } from './strip-safety-settings.ts';
import { stripUnsupportedPartFieldsFromGeminiGenerateContent } from './strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromGeminiGenerateContent } from './strip-unsupported-tools.ts';
import { dialChatWire } from '../dial-wire.ts';
import { geminiGenerateContentWireFor } from './wires.ts';
import type { Pipeline } from '@floway-dev/pipeline';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

export const geminiGenerateContentServePipeline = (payload: GeminiGenerateContentPayload): Pipeline<GeminiGenerateContentServeEntry, GeminiGenerateContentServeExit> =>
  compose('geminiGenerateContentServe', [
    writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400, STREAMED_USAGE),
    emitGeminiGenerateContent,
    resolveChatCandidates(narrowing(payload)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.geminiGenerateContent'?: unknown })['response.chat.geminiGenerateContent']),
      owns: ['response.http.body'],
      pendingUsage: STREAMED_USAGE,
    }),
    materializeAttempt('request.chat.geminiGenerateContent'),
    stripUnsupportedPartFieldsFromGeminiGenerateContent,
    stripUnsupportedToolsFromGeminiGenerateContent,
    stripSafetySettingsFromGeminiGenerateContent,
    suppressThoughtPartsFromGeminiGenerateContent,
    requireGeminiGenerateContentTerminal,
    dialChatWire({
      source: 'request.chat.geminiGenerateContent',
      needs: ['request.chat.geminiGenerateContent', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      provides: ['response.chat.geminiGenerateContent', STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
      pick: endpoints => geminiGenerateContentTarget.pick(endpoints),
      wire: geminiGenerateContentWireFor,
    }),
  ]);
