import { CHATGPT_ALPHA_SEARCH_PATH } from '../../constants.ts';
import { uuidV7 } from '../../ids.ts';
import { stringField, trimHeader } from '../../wire.ts';
import { dialChatGPT, dialResponseConsumes, dialResponseNeeds, formatError, HTTP_ERROR_BODY_BYTES } from '../dial.ts';
import { defineStage } from '../facts.ts';
import { codexRequest, incomingHeaders } from '../request.ts';
import { parseUpstreamResult } from '@floway-dev/upstream';

const SEARCH_BODY_BYTES = 16 * 1024 * 1024;

export const alphaSearchDial = defineStage({
  name: 'chatgpt.alphaSearch.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'alphaSearch'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, consumes: dialResponseConsumes, provides: ['http', 'alphaSearch'] },
  },
  return: { provides: ['http', 'alphaSearch'] },
  async execute(facts, scope) {
    const { http, upstream, model, alphaSearch } = facts;
    const id = stringField(alphaSearch, 'id') ?? uuidV7();
    const turnMetadata = trimHeader(incomingHeaders(http.headers), 'x-codex-turn-metadata');
    const dialed = await dialChatGPT(scope, {
      upstream,
      prepare: installationId => ({
        request: codexRequest(CHATGPT_ALPHA_SEARCH_PATH, 'application/json', { ...alphaSearch, model: model.id, id }, {
          installationId, sessionId: id, threadId: id, clientRequestId: id, turnId: uuidV7(), windowId: `${id}:0`,
        }, turnMetadata, false),
      }),
      next: (_, request) => scope.next({ ...facts, http: request }),
    });
    if (dialed.kind === 'error') return { http: dialed.http, alphaSearch: dialed.outcome };
    const parsed = await parseUpstreamResult(dialed.http, scope, bytes => ({ ok: true, value: bytes }), formatError,
      { maxResultBodyBytes: SEARCH_BODY_BYTES, maxErrorBodyBytes: HTTP_ERROR_BODY_BYTES });
    return { http: parsed.http, alphaSearch: parsed.outcome };
  },
});
