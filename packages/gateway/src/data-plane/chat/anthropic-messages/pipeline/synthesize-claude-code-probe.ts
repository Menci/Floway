import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { responseHead } from '../../../pipeline/response.ts';
import { move } from '@floway-dev/pipeline';
import { createAnthropicMessagesUsage, generateAnthropicId, toAnthropicMessagesUsageDelta, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolStreamError } from '@floway-dev/provider';

const { defineStage } = gatewayFactSpace<{}>();

export const synthesizeClaudeCodeProbe = defineStage({
  name: 'anthropicMessages.synthesize-claude-code-probe',
  request: { needs: ['serve.candidate'] },
  return: { provides: ['response.http', 'response.modelKey', 'response.anthropicMessages'] },
  async execute(facts, scope) {
    const { model } = facts['serve.candidate'];
    const stream = scope.createStream<AnthropicMessagesStreamEventEx, ProtocolStreamError>(async function* () {
      const usage = createAnthropicMessagesUsage(0, 0);
      yield {
        ok: true,
        value: {
          type: 'message_start',
          message: {
            id: generateAnthropicId('msg'),
            type: 'message',
            role: 'assistant',
            model: model.id,
            content: [],
            stop_reason: null,
            stop_details: null,
            container: null,
            diagnostics: null,
            stop_sequence: null,
            usage,
          },
        },
      };
      yield {
        ok: true, value: {
          type: 'message_delta',
          delta: { container: null, stop_reason: 'max_tokens', stop_details: null, stop_sequence: null },
          usage: toAnthropicMessagesUsageDelta(usage),
        },
      };
      yield { ok: true, value: { type: 'message_stop' } };
    });
    return {
      'response.http': move(responseHead(200)),
      'response.modelKey': model.id,
      'response.anthropicMessages': move({ kind: 'stream', stream } as const),
    };
  },
});
