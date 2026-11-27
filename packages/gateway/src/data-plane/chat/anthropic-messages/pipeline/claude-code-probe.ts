import { defineStage } from '../../pipeline/facts.ts';
import { getHeader } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { createAnthropicMessagesUsage, generateAnthropicId, toAnthropicMessagesUsageDelta, type AnthropicMessagesPayload, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolStreamError } from '@floway-dev/upstream';

// The CLI's one-token model and credential probes use these exact prompts.
// https://github.com/BerriAI/litellm/issues/35061
const probePrompts = new Set(['Hi', 'test']);

const isClaudeCodeProbe = (payload: AnthropicMessagesPayload, userAgent: unknown): boolean => {
  if (payload.max_tokens !== 1 || payload.tools !== undefined || payload.messages.length !== 1) return false;
  if (typeof userAgent !== 'string' || !/^claude-cli\/\d+\.\d+\.\d+/i.test(userAgent)) return false;
  const message = payload.messages[0];
  if (message?.role !== 'user') return false;
  if (typeof message.content === 'string') return probePrompts.has(message.content);
  const block = message.content[0];
  return message.content.length === 1 && block?.type === 'text' && probePrompts.has(block.text);
};

export const answerClaudeCodeProbe = defineStage({
  name: 'anthropicMessages.answer-claude-code-probe',
  through: {
    request: { needs: ['anthropicMessages', 'http'], provides: [], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'anthropicMessages'] },
  async execute(facts, scope) {
    const payload = facts.anthropicMessages;
    if (!isClaudeCodeProbe(payload, getHeader(facts.http.headers, 'user-agent'))) return await scope.next(facts);
    const stream = scope.createStream(async function* (): AsyncGenerator<Result<AnthropicMessagesStreamEventEx, ProtocolStreamError>> {
      const usage = createAnthropicMessagesUsage(0, 0);
      yield {
        ok: true,
        value: {
          type: 'message_start',
          message: {
            id: generateAnthropicId('msg'), type: 'message', role: 'assistant', model: payload.model, content: [],
            stop_reason: null, stop_details: null, container: null, diagnostics: null, stop_sequence: null, usage,
          },
        },
      };
      yield {
        ok: true,
        value: {
          type: 'message_delta', delta: { container: null, stop_reason: 'max_tokens', stop_details: null, stop_sequence: null },
          usage: toAnthropicMessagesUsageDelta(usage),
        },
      };
      yield { ok: true, value: { type: 'message_stop' } };
    });
    return { http: { status: 200, statusText: '', headers: [], body: null }, anthropicMessages: { kind: 'stream', stream } };
  },
});
