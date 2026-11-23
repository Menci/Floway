import { abortCopilotOpenAIResponsesToolArgumentWhitespace } from './abort-on-tool-argument-whitespace.ts';
import { compressCopilotOpenAIResponsesImages } from './compress-images.ts';
import { fillCopilotEmptyNamespaceDescriptions } from './fill-empty-namespace-descriptions.ts';
import { normalizeCopilotOpenAIResponsesCompactionResult, normalizeCopilotOpenAIResponsesFrames, restoreCopilotOpenAIResponsesInputItemIds } from './item-id-membrane.ts';
import { copilotOpenAIResponsesInitiator } from './set-initiator-header.ts';
import { copilotOpenAIResponsesHasImage } from './set-vision-header.ts';
import { stripCopilotImageGeneration } from './strip-image-generation.ts';
import { stripCopilotServiceTier } from './strip-service-tier.ts';
import { compactionResponse } from '../../compaction.ts';
import type { CopilotUpstreamFacts } from '../../config.ts';
import { headerStage, payloadStage, selectModelStage, unchanged, withPublicModel } from '../shared/stages.ts';
import { defineStage, transform } from '@floway-dev/pipeline';
import { isFastServiceTier } from '@floway-dev/protocols/common';
import { isOpenAIResponsesCompactionItem, type CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { deleteHeader, setHeader, type ProviderOpenAIResponsesOutput, type ProviderResponsesInput } from '@floway-dev/provider';

type Input = ProviderResponsesInput<CopilotUpstreamFacts>;
type Output = ProviderOpenAIResponsesOutput;

const itemIdMembrane = defineStage<Input, Input, Output, Output>({
  name: 'item-id-membrane',
  through: {
    request: { needs: ['request.payload', 'provider.model'], consumes: [], provides: ['request.payload'] },
    response: { needs: ['response.openaiResponses'], consumes: [], provides: ['response.openaiResponses'] },
  },
  execute: transform(scope => ({
    request(facts) {
      const { model: _model, ...payload } = restoreCopilotOpenAIResponsesInputItemIds(withPublicModel(facts));
      return { ...facts, 'request.payload': payload };
    },
    response(back) {
      const outcome = back['response.openaiResponses'];
      switch (outcome.kind) {
      case 'stream': {
        const events = scope.wrapStream(outcome.events, { label: 'responses.item-ids', transform: normalizeCopilotOpenAIResponsesFrames });
        return { ...back, 'response.openaiResponses': { ...outcome, events } };
      }
      case 'result':
        return { ...back, 'response.openaiResponses': { ...outcome, result: normalizeCopilotOpenAIResponsesCompactionResult(outcome.result) } };
      case 'error':
        return back;
      }
    },
  })),
});

const abortToolArgumentWhitespace = defineStage<{}, {}, Output, Output>({
  name: 'abort-on-tool-argument-whitespace',
  through: {
    request: unchanged,
    response: { needs: ['response.openaiResponses'], consumes: [], provides: ['response.openaiResponses'] },
  },
  execute: transform(scope => ({
    response(back) {
      const outcome = back['response.openaiResponses'];
      if (outcome.kind !== 'stream') return back;
      const events = scope.wrapStream(outcome.events, { label: 'responses.tool-arguments', transform: abortCopilotOpenAIResponsesToolArgumentWhitespace });
      return { ...back, 'response.openaiResponses': { ...outcome, events } };
    },
  })),
});

const normalizeCompaction = defineStage<Input, Input, Output, Output>({
  name: 'normalize-trigger-compaction',
  through: {
    request: { ...unchanged, needs: ['request.payload'] },
    response: { needs: ['response.http', 'response.openaiResponses'], consumes: [], provides: ['response.http', 'response.openaiResponses'] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const outcome = back['response.openaiResponses'];
    if (outcome.kind !== 'result') return back;
    const generated = outcome.result;
    if (!Array.isArray(generated?.output) || !generated.output.every(item => item && typeof item.type === 'string') ||
      !generated.output.some(isOpenAIResponsesCompactionItem)) {
      return {
        ...back,
        'response.http': { ...back['response.http'], status: 502, statusText: '' },
        'response.openaiResponses': {
          kind: 'error',
          source: 'upstream',
          error: { error: { type: 'upstream_invalid_json', message: "Copilot's compaction trigger turn returned no valid compaction output item" } },
        },
      };
    }
    const result = compactionResponse(facts['request.payload'].input, generated);
    return { ...back, 'response.openaiResponses': { ...outcome, result } };
  },
});

export const openAIResponsesStages = [
  selectModelStage<Input>('openaiResponses', ['request.payload'], facts => {
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
  headerStage<Input>('set-vision-header', ['request.payload', 'provider.model'], (facts, headers) =>
    copilotOpenAIResponsesHasImage(withPublicModel(facts))
      ? setHeader(headers, 'copilot-vision-request', 'true')
      : deleteHeader(headers, 'copilot-vision-request')),
  headerStage<Input>('set-initiator-header', ['request.payload', 'provider.model'], (facts, headers) =>
    setHeader(headers, 'x-initiator', copilotOpenAIResponsesInitiator(withPublicModel(facts)))),
  normalizeCompaction,
];
