import type { SourceProtocol } from '../composition.ts';
import { restateGeminiGenerateContentError } from './as-source/error-body.ts';
import { geminiGenerateContentRead } from './as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from './as-source/round-trip.ts';
import { geminiGenerateContentFromIR } from './as-source/sse-to.ts';
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
  read: geminiGenerateContentRead,
  sidecarRecognition: {
    inspect: findGeminiGenerateContentSidecarCarriers,
    verify: verifyGeminiGenerateContentTurnDigest,
    collectCandidates: collectGeminiGenerateContentReplayContents,
  },
  restateUpstreamError: restateGeminiGenerateContentError,
  // Stating a GenerateContent stream needs nothing the request produced.
  writeStream: (_payload, records, roundTrip) => geminiGenerateContentFromIR(records, { roundTrip }),
};
