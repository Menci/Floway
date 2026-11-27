import { CHATGPT_OPENAI_RESPONSES_COMPACT_PATH } from '../../constants.ts';
import { withoutUnsupportedFields, withDefaultInstructions } from '../../responses-request.ts';
import { prepareChatGPTResponsesRequest } from '../../wire.ts';
import { dialChatGPT, dialResponseConsumes, dialResponseNeeds, formatError, HTTP_ERROR_BODY_BYTES } from '../dial.ts';
import { defineStage } from '../facts.ts';
import { codexRequest, incomingHeaders } from '../request.ts';
import { decodeOpenAIResponsesCompactionResult } from '@floway-dev/protocols/openai-responses';
import { parseJsonBody, parseUpstreamResult } from '@floway-dev/upstream';

const COMPACTION_BODY_BYTES = 16 * 1024 * 1024;

export const openAIResponsesCompactDial = defineStage({
  name: 'chatgpt.openaiResponsesCompact.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiResponsesCompact'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, consumes: dialResponseConsumes, provides: ['http', 'openaiResponsesCompact'] },
  },
  return: { provides: ['http', 'openaiResponsesCompact'] },
  async execute(facts, scope) {
    const { http, upstream, model, openaiResponsesCompact } = facts;
    const body = withoutUnsupportedFields(withDefaultInstructions(openaiResponsesCompact, model));
    const headers = incomingHeaders(http.headers);
    const dialed = await dialChatGPT(scope, {
      upstream,
      prepare(installationId) {
        const prepared = prepareChatGPTResponsesRequest({ body, headers, model, installationId }, 'compact');
        return {
          request: codexRequest(CHATGPT_OPENAI_RESPONSES_COMPACT_PATH, 'application/json', prepared.body,
            prepared.identity, prepared.turnMetadataJson.header, prepared.responsesLite),
        };
      },
      next: (_, request) => scope.next({ ...facts, http: request }),
    });
    if (dialed.kind === 'error') return { http: dialed.http, openaiResponsesCompact: dialed.outcome };
    const parsed = await parseUpstreamResult(dialed.http, scope, bytes => {
      const body = parseJsonBody(bytes);
      return body.ok ? decodeOpenAIResponsesCompactionResult(body.value) : body;
    }, formatError, { maxResultBodyBytes: COMPACTION_BODY_BYTES, maxErrorBodyBytes: HTTP_ERROR_BODY_BYTES });
    return { http: parsed.http, openaiResponsesCompact: parsed.outcome };
  },
});
