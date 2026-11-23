import { abortCopilotOpenAIResponsesToolArgumentWhitespace } from './abort-on-tool-argument-whitespace.ts';
import { compressCopilotOpenAIResponsesImages } from './compress-images.ts';
import { fillCopilotEmptyNamespaceDescriptions } from './fill-empty-namespace-descriptions.ts';
import { normalizeCopilotOpenAIResponsesCompactionResult, normalizeCopilotOpenAIResponsesFrames, restoreCopilotOpenAIResponsesInputItemIds } from './item-id-membrane.ts';
import { copilotOpenAIResponsesInitiator } from './set-initiator-header.ts';
import { copilotOpenAIResponsesHasImage } from './set-vision-header.ts';
import { stripCopilotImageGeneration } from './strip-image-generation.ts';
import { stripCopilotServiceTier } from './strip-service-tier.ts';
import { compactionResponse } from '../../compaction.ts';
import { headerStage, payloadStage, selectModelStage, unchanged, withPublicModel } from '../shared/stages.ts';
import { defineStage, transform } from '@floway-dev/pipeline';
import { isFastServiceTier } from '@floway-dev/protocols/common';
import { parseOpenAIResponsesStream, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { parseSseStage, readHttpBody, type ProviderResponsesInput, type ProviderResponsesOutput, type ProviderServices, type ProviderStreamOutput } from '@floway-dev/provider';

const itemIdMembrane = defineStage<ProviderResponsesInput, ProviderResponsesInput, ProviderResponsesOutput, ProviderResponsesOutput, ProviderServices>({
  name: 'item-id-membrane',
  through: {
    request: { needs: ['request.payload', 'provider.model'], consumes: [], provides: ['request.payload'] },
    response: { needs: ['response.events', 'response.result'], consumes: [], provides: ['response.events', 'response.result'] },
  },
  execute: transform(env => ({
    request(facts) {
      const { model: _model, ...payload } = restoreCopilotOpenAIResponsesInputItemIds(withPublicModel(facts));
      return { ...facts, 'request.payload': payload };
    },
    response(back) {
      const events = back['response.events'];
      const result = back['response.result'];
      return {
        ...back,
        'response.events': events === undefined
          ? events
          : env.wrapStream(events, { label: 'responses.item-ids', transform: normalizeCopilotOpenAIResponsesFrames }),
        'response.result': result === undefined ? result : normalizeCopilotOpenAIResponsesCompactionResult(result),
      };
    },
  })),
});

const abortToolArgumentWhitespace = defineStage<{}, {}, ProviderResponsesOutput, ProviderResponsesOutput, ProviderServices>({
  name: 'abort-on-tool-argument-whitespace',
  through: {
    request: unchanged,
    response: { needs: ['response.events'], consumes: [], provides: ['response.events'] },
  },
  execute: transform(env => ({
    response(back) {
      const events = back['response.events'];
      if (events === undefined) return back;
      return {
        ...back,
        'response.events': env.wrapStream(events, {
          label: 'responses.tool-arguments',
          transform: abortCopilotOpenAIResponsesToolArgumentWhitespace,
        }),
      };
    },
  })),
});

const parseCompaction = defineStage<ProviderResponsesInput, ProviderResponsesInput, ProviderStreamOutput<OpenAIResponsesStreamEventEx>, ProviderResponsesOutput, ProviderServices>({
  name: 'parse-trigger-compaction',
  through: {
    request: { ...unchanged, needs: ['request.action', 'request.payload'] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.result'] },
  },
  async execute(facts, next) {
    const back = await next(facts);
    const http = back['response.http'];
    if (facts['request.action'] !== 'compact' || http.status < 200 || http.status >= 300) {
      return { ...back, 'response.result': undefined };
    }
    const generated: OpenAIResponsesResultEx = JSON.parse((await readHttpBody(http.body)).utf8());
    return {
      ...back,
      'response.http': { ...http, body: null },
      'response.result': compactionResponse(facts['request.payload'].input, generated),
    };
  },
});

export const openAIResponsesStages = [
  selectModelStage<ProviderResponsesInput>('openaiResponses', ['request.payload'], facts => {
    const body = facts['request.payload'];
    const effort = body.reasoning?.effort;
    return {
      reasoningEffort: effort && effort !== 'none' ? effort : undefined,
      fast: isFastServiceTier(body.service_tier),
    };
  }),
  payloadStage<CanonicalOpenAIResponsesPayload>('compress-images', compressCopilotOpenAIResponsesImages),
  payloadStage<CanonicalOpenAIResponsesPayload>('fill-empty-namespace-descriptions', fillCopilotEmptyNamespaceDescriptions),
  payloadStage<CanonicalOpenAIResponsesPayload>('strip-service-tier', stripCopilotServiceTier),
  payloadStage<CanonicalOpenAIResponsesPayload>('strip-image-generation', stripCopilotImageGeneration),
  itemIdMembrane,
  abortToolArgumentWhitespace,
  headerStage<ProviderResponsesInput>('set-vision-header', ['request.payload', 'provider.model'], (facts, headers) => {
    if (copilotOpenAIResponsesHasImage(withPublicModel(facts))) headers.set('copilot-vision-request', 'true');
  }),
  headerStage<ProviderResponsesInput>('set-initiator-header', ['request.payload', 'provider.model'], (facts, headers) => {
    headers.set('x-initiator', copilotOpenAIResponsesInitiator(withPublicModel(facts)));
  }),
  parseCompaction,
  parseSseStage<OpenAIResponsesStreamEventEx, ProviderResponsesInput>('parse-sse', parseOpenAIResponsesStream, {
    needs: ['request.action'],
    when: facts => facts['request.action'] === 'generate',
  }),
];
