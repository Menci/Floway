import { CHATGPT_OPENAI_IMAGES_EDITS_PATH } from '../../constants.ts';
import type { ChatGPTServices } from '../../service.ts';
import type { ChatGPTUpstreamFact } from '../../upstream-fact.ts';
import { authorizedCall, parseJsonObject, withoutTransportResponse } from '../authorized-call.ts';
import { codexImageRequest } from '../request.ts';
import { factSpace, move } from '@floway-dev/pipeline';
import { formatOpenAIImagesEditsError, isOpenAIImagesTerminalEvent, openAIImagesStreamRequested, parseOpenAIImagesStream } from '@floway-dev/protocols/openai-images';
import { parseResultBody, parseSseBody, serializeOpenAIImagesEditsJsonPayload, type ProviderOperationFacts, type ProviderTransportFacts } from '@floway-dev/provider';

export const { defineStage, compose } = factSpace<ProviderOperationFacts<'openaiImagesEdits', ChatGPTUpstreamFact> & ProviderTransportFacts, ChatGPTServices>();

const output = ['response.http', 'response.modelKey', 'response.openaiImagesEdits'] as const;

export const call = defineStage({
  name: 'chatgpt.call-openai-images-edits',
  through: {
    request: { needs: ['request.http', 'request.openaiImagesEdits', 'provider.upstream', 'provider.model'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.transport'], provides: output, consumes: ['response.transport'] },
  },
  return: { provides: output },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const payload = facts['request.openaiImagesEdits'];
    const upstream = facts['provider.upstream'];
    const model = facts['provider.model'];
    const modelKey = model.upstreamModelId;
    const prepareRequest = () => codexImageRequest(request, CHATGPT_OPENAI_IMAGES_EDITS_PATH, serializeOpenAIImagesEditsJsonPayload(payload, modelKey));
    const back = await authorizedCall(upstream, prepareRequest, true, scope,
      next => scope.next({ ...facts, 'request.http': next }), formatOpenAIImagesEditsError);
    const parse = (facts: ProviderTransportFacts) => openAIImagesStreamRequested(payload.parameters.stream)
      ? parseSseBody(facts, scope, parseOpenAIImagesStream, { kind: 'terminalEvent' as const, isTerminal: isOpenAIImagesTerminalEvent }, formatOpenAIImagesEditsError)
      : parseResultBody(facts, parseJsonObject, formatOpenAIImagesEditsError);
    const { http, outcome } = 'outcome' in back ? back : await parse(back);
    return {
      ...withoutTransportResponse(back),
      'response.http': move(http),
      'response.modelKey': modelKey,
      'response.openaiImagesEdits': move(outcome),
    };
  },
});
