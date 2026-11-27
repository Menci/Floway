import { CHATGPT_OPENAI_RESPONSES_PATH } from '../../constants.ts';
import { withoutUnsupportedFields, withDefaultInstructions } from '../../responses-request.ts';
import { prepareChatGPTResponsesRequest } from '../../wire.ts';
import { dialChatGPT, dialResponseConsumes, dialResponseNeeds, formatError, HTTP_ERROR_BODY_BYTES } from '../dial.ts';
import { defineStage } from '../facts.ts';
import { codexRequest, incomingHeaders } from '../request.ts';
import { decodeOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { parseUpstreamStream } from '@floway-dev/upstream';

export const openAIResponsesDial = defineStage({
  name: 'chatgpt.openaiResponses.dial',
  through: {
    request: {
      needs: ['http', 'upstream', 'model', 'openaiResponses'],
      provides: ['http', 'chatgpt.responsesLite.movedFields'],
      consumes: [],
    },
    response: {
      needs: [...dialResponseNeeds, 'chatgpt.openaiResponses.stream?'],
      consumes: [...dialResponseConsumes, 'chatgpt.openaiResponses.stream'],
      provides: ['http', 'openaiResponses'],
    },
  },
  return: { provides: ['http', 'openaiResponses'] },
  async execute(facts, scope) {
    const { http, upstream, model, openaiResponses } = facts;
    const body = withoutUnsupportedFields(withDefaultInstructions(openaiResponses, model));
    const headers = incomingHeaders(http.headers);
    const dialed = await dialChatGPT(scope, {
      upstream,
      prepare(installationId) {
        const prepared = prepareChatGPTResponsesRequest({ body, headers, model, installationId }, 'generate');
        return {
          movedFields: prepared.movedFields,
          request: codexRequest(CHATGPT_OPENAI_RESPONSES_PATH, 'text/event-stream', prepared.body,
            prepared.identity, prepared.turnMetadataJson.header, prepared.responsesLite),
        };
      },
      next: ({ movedFields }, request) => scope.next({ ...facts, http: request, 'chatgpt.responsesLite.movedFields': movedFields }),
    });
    if (dialed.kind === 'error') return { http: dialed.http, openaiResponses: dialed.outcome };
    const stream = dialed.answer['chatgpt.openaiResponses.stream'];
    if (stream !== undefined) return { http: dialed.http, openaiResponses: stream };
    const parsed = await parseUpstreamStream(dialed.http, scope, decodeOpenAIResponsesStream, formatError, HTTP_ERROR_BODY_BYTES);
    return { http: parsed.http, openaiResponses: parsed.outcome };
  },
});
