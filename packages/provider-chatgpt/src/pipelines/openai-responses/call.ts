import { CHATGPT_OPENAI_RESPONSES_PATH } from '../../constants.ts';
import { projectChatGPTResponsesEvent, type ChatGPTResponsesLiteRequest } from '../../responses-lite.ts';
import { createChatGPTResponsesOutputRestore } from '../../responses-output.ts';
import { prepareChatGPTResponsesRequest } from '../../responses-request.ts';
import { authorizedCall, withoutTransportResponse } from '../authorized-call.ts';
import { codexRequest, trimHeader } from '../request.ts';
import { defineStage } from './facts.ts';
import { move } from '@floway-dev/pipeline';
import { formatOpenAIResponsesError, isOpenAIResponsesTerminalEvent, parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { parseSseBody } from '@floway-dev/provider';

const output = ['response.http', 'response.modelKey', 'response.openaiResponses'] as const;

export const call = defineStage({
  name: 'chatgpt.call-openai-responses',
  through: {
    request: { needs: ['request.http', 'request.openaiResponses', 'provider.upstream', 'provider.model'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.transport'], provides: output, consumes: ['response.transport'] },
  },
  return: { provides: output },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const model = facts['provider.model'];
    let movedFields: Readonly<ChatGPTResponsesLiteRequest['movedFields']> | undefined;
    const prepareRequest = (deviceId: string) => {
      const prepared = prepareChatGPTResponsesRequest({
        body: facts['request.openaiResponses'],
        model,
        modelKey: model.upstreamModelId,
        deviceId,
        getHeader: name => trimHeader(request.headers, name),
      }, 'generate');
      movedFields = prepared.movedFields;
      return codexRequest(request, CHATGPT_OPENAI_RESPONSES_PATH, prepared.body, 'text/event-stream',
        prepared.identity, prepared.turnMetadataJson.header, prepared.responsesLite);
    };
    const back = await authorizedCall(facts['provider.upstream'], prepareRequest, false, scope,
      next => scope.next({ ...facts, 'request.http': next }), formatOpenAIResponsesError);
    const { http, outcome } = 'outcome' in back ? back : await parseSseBody(
      back, scope,
      parseOpenAIResponsesStream, { kind: 'terminalEvent', isTerminal: isOpenAIResponsesTerminalEvent }, formatOpenAIResponsesError,
    );
    const output = {
      ...withoutTransportResponse(back),
      'response.http': move(http),
      'response.modelKey': model.upstreamModelId,
    };
    if (outcome.kind !== 'stream') return { ...output, 'response.openaiResponses': move(outcome) };
    const liteFields = movedFields;
    if (liteFields === undefined) throw new TypeError('A ChatGPT Responses stream requires a prepared request');
    const projectLite = Object.keys(liteFields).length > 0;
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      const restore = createChatGPTResponsesOutputRestore();
      const cursor = source[Symbol.asyncIterator]();
      let failed = false;
      for (;;) {
        const { done, value: item } = await cursor.next();
        if (done) return;
        if (failed) continue;
        if (!item.ok) {
          yield item;
          continue;
        }
        const event = restore(projectLite ? projectChatGPTResponsesEvent(item.value, liteFields) : item.value);
        yield event;
        if (!event.ok) {
          failed = true;
          producer.abort(back);
        }
      }
    });
    return { ...output, 'response.openaiResponses': move({ ...outcome, stream }) };
  },
});
