import { defineCopilotStage } from '../facts.ts';
import { formatAnthropicMessagesError } from '../shared/format-errors.ts';
import { ERROR_BODY_BYTES, RESULT_BODY_BYTES } from '../shared/wire-request.ts';
import { decodeAnthropicMessagesCountTokensResult } from '@floway-dev/protocols/anthropic-messages';
import { isJsonObject } from '@floway-dev/protocols/common';
import { parseJsonBody, parseUpstreamResult, type UpstreamResult } from '@floway-dev/upstream';

export const parse = defineCopilotStage({
  name: 'copilot.anthropicMessagesCountTokens.parse',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'anthropicMessagesCountTokens?'], provides: ['http', 'anthropicMessagesCountTokens'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const { http, anthropicMessagesCountTokens: outcome } = back;
    if (outcome !== undefined) return { ...back, anthropicMessagesCountTokens: outcome };
    if (http === null) throw new Error('Copilot anthropicMessagesCountTokens has neither an HTTP response nor an outcome');
    const parsed = await parseUpstreamResult<UpstreamResult<'anthropicMessagesCountTokens'>>(http, scope, (bytes, head) => {
      if (head.status === 204 || head.status === 205) return { ok: true, value: null };
      const parsed = parseJsonBody(bytes);
      if (!parsed.ok) return parsed;
      const body = parsed.value;
      const native = decodeAnthropicMessagesCountTokensResult(body);
      if (native.ok || !isJsonObject(body)) return native;
      const vendor = decodeAnthropicMessagesCountTokensResult({ ...body, input_tokens: body.total_tokens });
      return vendor.ok ? vendor : native;
    }, formatAnthropicMessagesError, {
      maxResultBodyBytes: RESULT_BODY_BYTES,
      maxErrorBodyBytes: ERROR_BODY_BYTES,
    });
    return { ...back, http: parsed.http, anthropicMessagesCountTokens: parsed.outcome };
  },
});
