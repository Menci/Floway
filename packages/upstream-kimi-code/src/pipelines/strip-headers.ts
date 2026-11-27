import { defineStage } from './facts.ts';
import { filterHeaders } from '@floway-dev/http';

const stripHeaders = (name: string, keep: (name: string) => boolean) => defineStage({
  name,
  through: {
    request: { needs: ['http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { http } = facts;
    return await scope.next({ ...facts, http: { ...http, headers: filterHeaders(http.headers, keep) } });
  },
});

export const stripOpenAIHeaders = stripHeaders('kimi-code.strip-openai-headers', () => false);

// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
export const stripAnthropicMessagesHeaders = stripHeaders('kimi-code.strip-anthropic-messages-headers', name => name === 'anthropic-beta');
