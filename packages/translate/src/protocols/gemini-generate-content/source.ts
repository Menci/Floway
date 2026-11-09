import { geminiGenerateContentErrorWriter } from './as-source/error-body.ts';
import { geminiGenerateContentDropsReasoning, geminiGenerateContentOpen } from './as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from './as-source/round-trip.ts';
import { geminiGenerateContentFromIR } from './as-source/sse-to.ts';
import type { SourceProtocol } from '../composition.ts';
import type { GeminiGenerateContentRequest, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

/**
 * GenerateContent read as the side a request comes from.
 *
 * A GenerateContent turn already holds the contents the model stated, so the
 * structure a sidecar describes is that run as it stands.
 */
export const geminiGenerateContentSourceProtocol: SourceProtocol<
  'geminiGenerateContent', GeminiGenerateContentRequest, GeminiGenerateContentStreamEvent
> = {
  name: 'geminiGenerateContent',
  open: geminiGenerateContentOpen,
  dropsReasoning: geminiGenerateContentDropsReasoning,
  roundTrip: {
    inspect: findGeminiGenerateContentSidecarCarriers,
    verify: verifyGeminiGenerateContentTurnDigest,
    collectCandidates: collectGeminiGenerateContentReplayContents,
  },
  writeError: geminiGenerateContentErrorWriter,
  // Stating a GenerateContent stream needs nothing the request produced.
  writeStream: (_layout, records, writer) => geminiGenerateContentFromIR(records, { roundTrip: writer }),
};
