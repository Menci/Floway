import { openAIAudioTranscriptionsEgress } from './egress.ts';
import { openAIAudioTranscriptionsError, parseOpenAIAudioTranscriptions } from './parse.ts';
import { renderOpenAIAudioTranscriptions } from './render.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { encodeResponse } from '../../pipeline/encode-response.ts';
import { gatewayFactSpace, httpEntry } from '../../pipeline/facts.ts';
import { failover } from '../../pipeline/failover.ts';
import { providerSupportsOperation } from '../../pipeline/provider-pipelines.ts';
import { requestBody } from '../../pipeline/request-body.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { stripFlowayAuth } from '../../pipeline/strip-floway-auth.ts';
import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';

const { compose } = gatewayFactSpace<GatewayServices>();

export const openAIAudioTranscriptionsPipeline = compose('openaiAudioTranscriptions.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [
    requestBody,
    stripFlowayAuth,
    parseOpenAIAudioTranscriptions,
    encodeResponse('response.openaiAudioTranscriptions', renderOpenAIAudioTranscriptions),
    discoverCandidates('transcription'),
    failover('response.openaiAudioTranscriptions', (model, { sawModel, failedUpstreams }) => {
      const message = sawModel
        ? `Model ${model} does not support the /audio/transcriptions endpoint.`
        : `Model ${model} is not available on any configured upstream.`;
      return openAIAudioTranscriptionsError(sawModel ? 400 : 404, appendFailedUpstreams(message, failedUpstreams));
    }, candidate => candidate.model.endpoints.openaiAudioTranscriptions !== undefined && providerSupportsOperation(candidate.upstream.kind, 'openaiAudioTranscriptions')),
    ...openAIAudioTranscriptionsEgress.stages,
  ],
  ending: openAIAudioTranscriptionsEgress.ending,
  targets: openAIAudioTranscriptionsEgress.targets,
});
