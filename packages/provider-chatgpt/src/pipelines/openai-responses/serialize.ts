import { defineStage } from './facts.ts';
import { CHATGPT_OPENAI_RESPONSES_PATH } from '../../constants.ts';
import { projectChatGPTResponsesEvent, type ChatGPTResponsesLiteRequest } from '../../responses-lite.ts';
import { createChatGPTResponsesOutputRestore } from '../../responses-output.ts';
import { prepareChatGPTResponsesRequest } from '../../responses-request.ts';
import { codexRequest, trimHeader } from '../request.ts';
import { move, transform } from '@floway-dev/pipeline';

export const serialize = defineStage({
  name: 'chatgpt.serialize-openai-responses',
  through: {
    request: { needs: ['request.http', 'request.openaiResponses', 'provider.upstream', 'provider.model'], provides: ['request.http'], consumes: [] },
    response: { needs: ['response.openaiResponses'], provides: ['response.openaiResponses'], consumes: [] },
  },
  execute: transform(scope => {
    let movedFields: ChatGPTResponsesLiteRequest['movedFields'];
    return {
      async request(facts) {
        const request = facts['request.http'];
        const model = facts['provider.model'];
        const prepared = prepareChatGPTResponsesRequest({
          body: facts['request.openaiResponses'],
          model,
          modelKey: model.upstreamModelId,
          deviceId: await scope.services.chatgpt.deviceId(facts['provider.upstream']),
          getHeader: name => trimHeader(request.headers, name),
        }, 'generate');
        movedFields = prepared.movedFields;
        return {
          ...facts,
          'request.http': codexRequest(request, CHATGPT_OPENAI_RESPONSES_PATH, prepared.body, 'text/event-stream',
            prepared.identity, prepared.turnMetadataJson.header, prepared.responsesLite),
        };
      },
      response(back) {
        const outcome = back['response.openaiResponses'];
        if (outcome.kind !== 'stream') return back;
        const projectLite = Object.keys(movedFields).length > 0;
        const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
          const restore = createChatGPTResponsesOutputRestore();
          let failed = false;
          for await (const item of source) {
            if (failed) continue;
            if (!item.ok) {
              yield item;
              continue;
            }
            let event;
            try {
              event = restore(projectLite ? projectChatGPTResponsesEvent(item.value, movedFields) : item.value);
            } catch (cause) {
              failed = true;
              producer.abort(back);
              yield { ok: false, error: { kind: 'protocol', cause } } as const;
              continue;
            }
            yield { ok: true, value: event };
          }
        });
        return { ...back, 'response.openaiResponses': move({ ...outcome, stream }) };
      },
    };
  }),
});
