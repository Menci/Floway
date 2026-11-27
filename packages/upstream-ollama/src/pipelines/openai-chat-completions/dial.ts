import { OLLAMA_INFERENCE_PATHS } from '../../fetch.ts';
import { defineStage, HTTP_ANSWER, MODEL_ENTRY } from '../facts.ts';
import { dialJson } from '../request.ts';
import { decodeStream, formatOpenAIError } from '../response.ts';
import { renameOutputCap } from './rename-output-cap.ts';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';

export const openaiChatCompletions = defineStage({
  name: 'ollama.openaiChatCompletions.dial',
  through: {
    request: { needs: [...MODEL_ENTRY, 'openaiChatCompletions'], provides: ['http'], consumes: [] },
    response: { needs: HTTP_ANSWER, provides: ['http', 'openaiChatCompletions'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { http, upstream, model: { upstreamModelId: model } } = facts;
    const payload = renameOutputCap(facts.openaiChatCompletions);
    const request = dialJson(http, upstream, OLLAMA_INFERENCE_PATHS.openaiChatCompletions, { ...payload, model, stream: true });
    const answer = await scope.next({ ...facts, http: request });
    const { outcome, ...response } = await decodeStream(answer, scope, formatOpenAIError, decodeOpenAIChatCompletionsStream);
    return { ...response, openaiChatCompletions: outcome };
  },
});
