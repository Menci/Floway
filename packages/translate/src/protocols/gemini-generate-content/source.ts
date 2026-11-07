import type { GeminiGenerateContentConversationTurn } from './as-source/conversation-turns.ts';
import type { IRRecord } from '../../ir/output/stream.ts';
import type { RoundTripWriter } from '../../round-trip/stream.ts';
import type { SourceProtocol, SourceReading } from '../composition.ts';
import { geminiGenerateContentErrorWriter } from './as-source/error-body.ts';
import { geminiGenerateContentDropsReasoning, geminiGenerateContentSource, type GeminiGenerateContentSource } from './as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, type GeminiGenerateContentAssistantTurn } from './as-source/round-trip.ts';
import { geminiGenerateContentFromIR } from './as-source/sse-to.ts';
import type { GeminiGenerateContentRequest, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

/**
 * GenerateContent read as the side a request comes from.
 *
 * A GenerateContent turn already holds the contents the model stated, so the
 * assistant part a sidecar describes is that run as it stands.
 */
export const geminiGenerateContentSourceProtocol: SourceProtocol<
  'geminiGenerateContent', GeminiGenerateContentRequest, GeminiGenerateContentConversationTurn, GeminiGenerateContentAssistantTurn, GeminiGenerateContentStreamEvent
> = {
  name: 'geminiGenerateContent',
  read: (payload): SourceReading<'geminiGenerateContent', GeminiGenerateContentConversationTurn, GeminiGenerateContentAssistantTurn, GeminiGenerateContentStreamEvent> => {
    const source: GeminiGenerateContentSource = geminiGenerateContentSource(payload);
    return {
      request: source.request,
      input: source,
      assistantTurn: turn => turn.role === 'assistant' ? turn.items : undefined,
      dropsReasoning: geminiGenerateContentDropsReasoning,
      roundTrip: {
        inspect: findGeminiGenerateContentSidecarCarriers,
        verify: verifyGeminiGenerateContentTurnDigest,
        collectCandidates: collectGeminiGenerateContentReplayContents,
      },
      output: (records: AsyncIterable<IRRecord>, writer: RoundTripWriter<'geminiGenerateContent'>) =>
        geminiGenerateContentFromIR(records, { roundTrip: writer }),
    };
  },
  writeError: geminiGenerateContentErrorWriter,
};
