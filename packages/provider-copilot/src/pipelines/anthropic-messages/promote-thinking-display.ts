import { copilotRawModelId } from '../../model-name.ts';
import { defineCopilotStage } from '../facts.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesThinkingDisplay } from '@floway-dev/protocols/anthropic-messages';

const CLAUDE_VERSION_PATTERN = /(?:^|-)(\d+)\.(\d+)(?=-|$)/;

const isAnthropicMessagesThinkingDisplay = (value: unknown): value is AnthropicMessagesThinkingDisplay => value === 'omitted' || value === 'summarized' || value === 'full';

const isClaudeVersionAtLeast = (model: string, major: number, minor: number): boolean => {
  const normalized = copilotRawModelId(model);
  if (!normalized.startsWith('claude-')) return false;

  const match = normalized.match(CLAUDE_VERSION_PATTERN);
  if (!match) return false;

  const modelMajor = Number(match[1]);
  const modelMinor = Number(match[2]);

  return modelMajor > major || (modelMajor === major && modelMinor >= minor);
};

export const resolveAnthropicMessagesDownstreamThinkingDisplay = (payload: AnthropicMessagesPayload, modelId: string): AnthropicMessagesThinkingDisplay | undefined => {
  const thinking = payload.thinking;
  const display = thinking?.type === 'enabled' || thinking?.type === 'adaptive' ? thinking.display : undefined;
  if (display !== undefined) {
    // Request JSON is not runtime-validated before shaping stages; leave
    // unknown display values untouched so upstream, not this workaround, owns
    // rejecting or accepting future values.
    return isAnthropicMessagesThinkingDisplay(display) ? display : undefined;
  }

  return isClaudeVersionAtLeast(modelId, 4, 7) ? 'omitted' : 'summarized';
};

/**
 * Workaround for Copilot/Claude turns that go silent during long extended
 * thinking, then surface to clients as `API Error: Network connection lost`,
 * `Stream idle timeout`, or a short no-tool-call turn. The direct Copilot
 * references below document a roughly 60s HTTP response-idle boundary in
 * GitHub Copilot paths; the related client reports show the same user-visible
 * stall/no-output failure shape in official Copilot and Claude Code clients.
 *
 * The native Copilot Anthropic Messages target is the boundary where `thinking.display`
 * controls whether the upstream emits token-level `thinking_delta` SSE while
 * the model is reasoning. Our Copilot probes found Claude 4.7 defaults to
 * omitted display, while 4.6/4.5 default to summarized; forcing summarized
 * upstream keeps data flowing during thinking and avoids the idle gap. To keep
 * downstream omitted semantics, this stage removes only thinking
 * text/deltas after the upstream attempt and preserves every `signature` byte;
 * the same probes showed blank thinking text is accepted, while any signature
 * tampering makes the next Anthropic Messages request fail with 400. Those probes justify
 * the request/response mechanics here; the public references justify why this
 * workaround exists.
 *
 * References:
 * Direct Copilot HTTP idle-boundary reports:
 * - https://github.com/ericc-ch/copilot-api/issues/223
 * - https://github.com/copilot-extensions/user-feedback/issues/2
 * Related official-client and downstream symptoms:
 * - https://github.com/microsoft/vscode-copilot-release/issues/7640
 * - https://github.com/github/copilot-cli/issues/686
 * - https://github.com/github/copilot-cli/issues/1614
 * - https://github.com/anthropics/claude-code/issues/46987
 * - https://github.com/anthropics/claude-code/issues/50477
 */

export const promoteThinkingDisplay = defineCopilotStage({
  name: 'copilot.anthropicMessages.promoteThinkingDisplay',
  through: {
    request: { needs: ['request.anthropicMessages', 'provider.model'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: ['response.anthropicMessages'], provides: ['response.anthropicMessages'], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.anthropicMessages'];
    const display = resolveAnthropicMessagesDownstreamThinkingDisplay(payload, facts['provider.model'].id);
    const thinking = payload.thinking;
    const active = thinking?.type === 'enabled' || thinking?.type === 'adaptive';
    const back = await scope.next(active && display !== undefined && display !== 'full' ? {
      ...facts,
      'request.anthropicMessages': { ...payload, thinking: { ...thinking, display: 'summarized' } },
    } : facts);
    const outcome = back['response.anthropicMessages'];
    if (!active || display !== 'omitted' || outcome.kind !== 'stream') return back;

    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (!item.ok) {
          yield item;
          continue;
        }
        const event = item.value;
        if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') continue;
        yield event.type === 'content_block_start' && event.content_block.type === 'thinking'
          ? { ok: true, value: { ...event, content_block: { ...event.content_block, thinking: '' } } }
          : item;
      }
    });
    return { ...back, 'response.anthropicMessages': { kind: 'stream', stream } };
  },
});
