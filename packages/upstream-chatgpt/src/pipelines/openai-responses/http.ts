import { projectMovedChatGPTResponsesEventFields, type ChatGPTResponsesLiteRequest } from '../../responses-lite.ts';
import { createChatGPTResponsesOutputRestorer } from '../../responses-output.ts';
import { defineStage } from '../facts.ts';
import { getHeader, sendHttpRequest, setHeader, type HttpResponseSource } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { decodeOpenAIResponsesStream, isOpenAIResponsesTerminalEvent, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/upstream';

export const openAIResponsesHttp = defineStage({
  name: 'chatgpt.openaiResponses.http',
  request: { needs: ['http', 'upstream', 'chatgpt.responsesLite.movedFields'] },
  return: { provides: ['http', 'http.error?', 'chatgpt.openaiResponses.stream?'] },
  async execute({ http, upstream, 'chatgpt.responsesLite.movedFields': movedFields }, scope) {
    const { body, ...request } = http;
    if (typeof body !== 'string') throw new TypeError('ChatGPT Responses requires a serialized JSON request');
    const sent = await sendHttpRequest(scope.services.fetcher(upstream.id), { ...request, body }, scope.signal);
    if (!sent.ok) return { http: null, 'http.error': sent.error };

    const { body: source, ...head } = sent.value;
    if (head.status < 200 || head.status >= 300) {
      return { http: { ...head, body: source === null ? null : scope.createStream(() => source) } };
    }
    // Codex decodes successful HTTP bodies as SSE independent of Content-Type.
    // https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/endpoint/responses.rs#L109-L133
    const mediaType = getHeader(head.headers, 'content-type');
    const headers = typeof mediaType === 'string' && isEventStreamMediaType(mediaType)
      ? head.headers
      : setHeader(head.headers, 'content-type', 'text/event-stream');
    const response = { ...head, headers, body: null };
    if (source === null) return { http: response };

    return {
      http: response,
      'chatgpt.openaiResponses.stream': {
        kind: 'stream',
        stream: scope.createStream(() => decodeCodexResponses(source, movedFields)),
      },
    };
  },
});

// Codex regards the response.completed event as the end of HTTP SSE after
// forwarding the event into its session loop.
// https://github.com/openai/codex/blob/0a2eb4696c/codex-rs/codex-api/src/sse/responses.rs#L300-L364
const decodeCodexResponses = async function* (
  source: NonNullable<HttpResponseSource['body']>, movedFields: ChatGPTResponsesLiteRequest['movedFields'],
): AsyncGenerator<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>, void, unknown> {
  const restore = createChatGPTResponsesOutputRestorer();
  try {
    for await (const item of decodeOpenAIResponsesStream(source)) {
      if (!item.ok) {
        await source.return();
        yield item;
        return;
      }
      const restored = restore(projectMovedChatGPTResponsesEventFields(item.value, movedFields));
      if (!restored.ok) {
        await source.return();
        yield { ok: false, error: { kind: 'protocol', cause: restored.error } };
        return;
      }
      const terminal = isOpenAIResponsesTerminalEvent(restored.value);
      if (terminal) await source.return();
      yield restored;
      if (terminal) return;
    }
  } finally {
    await source.return();
  }
};
