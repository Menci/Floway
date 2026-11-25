import { copilotRawModelId } from '../../model-name.ts';
import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesThinkingDisplay } from '@floway-dev/protocols/anthropic-messages';

// Forcing summarized thinking keeps Copilot's SSE connection active during long reasoning turns.
// Clients requesting omitted display see an empty thinking block and retain the original signature.
// https://github.com/ericc-ch/copilot-api/issues/223
// https://github.com/microsoft/vscode-copilot-release/issues/7640
export const promoteThinkingDisplay = defineCopilotStage({
  name: 'copilot.anthropicMessages.promoteThinkingDisplay',
  through: {
    request: { needs: ['request.anthropicMessages', 'provider.model'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: ['response.anthropicMessages'], provides: ['response.anthropicMessages'], consumes: [] },
  },
  execute: transform(scope => {
    let omit: boolean;
    return {
      request(facts) {
        const payload = facts['request.anthropicMessages'];
        const { thinking } = payload;
        omit = false;
        if (thinking?.type !== 'enabled' && thinking?.type !== 'adaptive') return facts;
        const display = resolveAnthropicMessagesDownstreamThinkingDisplay(payload, facts['provider.model'].id);
        omit = display === 'omitted';
        if (display === undefined || display === 'full') return facts;
        return {
          ...facts,
          'request.anthropicMessages': move({ ...payload, thinking: { ...thinking, display: 'summarized' } }),
        };
      },
      response(facts) {
        const outcome = facts['response.anthropicMessages'];
        if (!omit || outcome.kind !== 'stream') return facts;
        const stream = scope.wrapStream(outcome.stream, async function* (source) {
          for await (const item of source) {
            if (!item.ok) {
              yield item;
              continue;
            }
            const event = item.value;
            if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') continue;
            if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
              yield { ok: true, value: { ...event, content_block: { ...event.content_block, thinking: '' } } } as const;
            } else {
              yield item;
            }
          }
        });
        return { ...facts, 'response.anthropicMessages': move({ kind: 'stream', stream }) };
      },
    };
  }),
});

const CLAUDE_VERSION_PATTERN = /(?:^|-)(\d+)\.(\d+)(?=-|$)/;

export const resolveAnthropicMessagesDownstreamThinkingDisplay = (
  payload: Pick<AnthropicMessagesPayload, 'thinking'>,
  model: string,
): AnthropicMessagesThinkingDisplay | undefined => {
  const { thinking } = payload;
  const display = thinking?.type === 'enabled' || thinking?.type === 'adaptive' ? thinking.display : undefined;
  if (display !== undefined) return display === 'omitted' || display === 'summarized' || display === 'full' ? display : undefined;
  const normalized = copilotRawModelId(model);
  const match = normalized.startsWith('claude-') ? CLAUDE_VERSION_PATTERN.exec(normalized) : null;
  if (match === null) return 'summarized';
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 4 || (major === 4 && minor >= 7) ? 'omitted' : 'summarized';
};
