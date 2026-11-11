import { restateGeminiGenerateContentError } from './as-source/error-body.ts';
import { writeGeminiGenerateContentEvents } from './as-source/events.ts';
import { readGeminiGenerateContentRequest } from './as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarOccurrences, verifyGeminiGenerateContentTurnDigest } from './as-source/round-trip.ts';
import type { SourceProtocol } from '../../composition/index.ts';
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
  read: readGeminiGenerateContentRequest,
  sidecarRecognition: {
    inspect: findGeminiGenerateContentSidecarOccurrences,
    verify: verifyGeminiGenerateContentTurnDigest,
    collectCandidates: collectGeminiGenerateContentReplayContents,
  },
  error: restateGeminiGenerateContentError,
  // Stating a GenerateContent stream needs nothing the request produced.
  writeEvents: (_payload, records, roundTrip) => writeGeminiGenerateContentEvents(records, { roundTrip }),
};
