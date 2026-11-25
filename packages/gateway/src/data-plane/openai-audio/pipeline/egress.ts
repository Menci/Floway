import { computeUsage } from '../../pipeline/compute-usage.ts';
import { enterProvider } from '../../pipeline/enter-provider.ts';
import { recordPerformance } from '../../pipeline/performance.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';
import { normalizeDamagedUpstreamResponse } from '../../shared/normalize-damaged-upstream-response.ts';
import { measureOpenAIAudioTranscriptionsResult, observeOpenAIAudioTranscriptionsStream } from '../usage.ts';

export const openAIAudioTranscriptionsEgress = {
  stages: [
    normalizeDamagedUpstreamResponse('response.openaiAudioTranscriptions'),
    storeUsage,
    recordPerformance('response.openaiAudioTranscriptions', 'audio_transcription'),
    computeUsage('response.openaiAudioTranscriptions', {
      kind: 'billable',
      result: measureOpenAIAudioTranscriptionsResult,
      stream: observeOpenAIAudioTranscriptionsStream,
    }),
  ],
  ...enterProvider('openaiAudioTranscriptions'),
};
