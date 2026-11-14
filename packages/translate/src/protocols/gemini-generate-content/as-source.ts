import { restateGeminiGenerateContentError } from './as-source/error-body.ts';
import { writeGeminiGenerateContentEvents } from './as-source/events.ts';
import { readGeminiGenerateContentRequest } from './as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarOccurrences, verifyGeminiGenerateContentTurnDigest } from './as-source/round-trip.ts';
import type { SourceProtocol } from '../../composition/index.ts';
import type { GeminiGenerateContentRequest, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

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
  writeEvents: (payload, records, roundTrip) => writeGeminiGenerateContentEvents(records, {
    includeThoughts: payload.generationConfig?.thinkingConfig?.includeThoughts === true,
    roundTrip,
  }),
};
