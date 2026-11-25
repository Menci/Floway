import { openAIResponsesExit, openAIResponsesFactSpace } from './facts.ts';
import { responseHead } from '../../../pipeline/response.ts';
import type { UsageStoreServices } from '../../../pipeline/store-usage.ts';
import { currentHour } from '../../../shared/telemetry/hour.ts';
import { syntheticEventsFromResult } from '../items/output.ts';
import { move } from '@floway-dev/pipeline';
import { priceRequest } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/provider';

const { defineStage } = openAIResponsesFactSpace<UsageStoreServices>();

// Codex prewarms the session so its next request can reference the input by
// response ID without incurring an inference call.
// https://github.com/openai/codex/blob/6989c6548b3737f108e2bb5ae1171b1d2032e30c/codex-rs/core/src/client.rs#L2181-L2184
export const answerOpenAIResponsesWebSocketWarmup = defineStage({
  name: 'openaiResponses.websocket-warmup',
  through: {
    request: {
      needs: ['request.openaiResponses', 'request.ws.responseId?', 'request.auth.apiKeyId', 'serve.candidate'],
      provides: [],
      consumes: [],
    },
    response: { needs: openAIResponsesExit, provides: [], consumes: [] },
  },
  return: { provides: openAIResponsesExit },
  async execute(facts, scope) {
    const request = facts['request.openaiResponses'];
    const responseId = facts['request.ws.responseId'];
    if (responseId === undefined || request.generate !== false) return await scope.next(facts);
    const { model, upstream } = facts['serve.candidate'];
    const stream = scope.createStream<OpenAIResponsesStreamEventEx, ProtocolStreamError>(async function* () {
      for await (const frame of syntheticEventsFromResult({
        id: responseId,
        object: 'response',
        model: model.id,
        status: 'completed',
        output: [],
        error: null,
        incomplete_details: null,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      })) {
        if (frame.type === 'event') yield { ok: true, value: frame.event } as const;
      }
    });

    scope.defer(scope.services.storeUsage({
      keyId: facts['request.auth.apiKeyId'],
      model: model.id,
      upstream: upstream.id,
      modelKey: model.id,
      hour: currentHour(),
      pricingSelector: priceRequest(model.pricing ?? null, {}).selector,
      requests: 1,
      metrics: [],
    }).catch(error => {
      scope.log.warn('Floway could not record OpenAI Responses warmup usage', { error });
    }));

    return {
      'response.http': move(responseHead(200)),
      'response.openaiResponses': move({ kind: 'stream', stream } as const),
    };
  },
});
