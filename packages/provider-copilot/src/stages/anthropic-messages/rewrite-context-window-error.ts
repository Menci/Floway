import { exchangeResponse, takeHttpResponse } from '@floway-dev/http/pipeline';
import { defineStage, move, setRelease } from '@floway-dev/pipeline';
import { buildPromptTooLongBody } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderChatResponse } from '@floway-dev/provider';

export const rewriteCopilotContextWindowError = defineStage<object, object, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'> & { 'response.copilot.errorBody': unknown }>({
  name: 'rewriteCopilotContextWindowError',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.http.exchange', 'response.http.body', 'response.provider.output'], consumes: ['response.http.exchange', 'response.http.body', 'response.provider.output'], provides: ['response.http.exchange', 'response.http.body', 'response.provider.output', 'response.copilot.errorBody'] },
  },
  execute: async (facts, next) => {
    const back = await next(move({ ...facts }));
    const exchange = back['response.http.exchange'];
    if (exchange.type !== 'response' || exchange.status >= 200 && exchange.status < 300) return move({ ...back, 'response.copilot.errorBody': null });
    const bytes = new Uint8Array(await exchangeResponse(exchange).arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    if (exchange.body !== null) setRelease(exchange.body, async () => {});
    let body: unknown;
    try { body = JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) throw error; body = text; }
    const tooLong = text.includes('Request body is too large for model context window') || text.includes('context_length_exceeded');
    if (!tooLong) {
      const replay = takeHttpResponse(new Response(exchange.body === null ? null : bytes, { status: exchange.status, statusText: exchange.statusText, headers: exchange.headers.map(([name, value]): [string, string] => [name, value]) }));
      return move({ ...back, 'response.http.exchange': replay, 'response.http.body': replay.body, 'response.copilot.errorBody': body });
    }
    const rewritten: unknown = JSON.parse(new TextDecoder().decode(buildPromptTooLongBody()));
    return move({
      ...back, 'response.copilot.errorBody': body, 'response.provider.output': {
        status: 400,
        message: 'prompt is too long',
        body: rewritten,
      },
    });
  },
});
