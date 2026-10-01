import type { MessagesFacts } from '../../chat-facts.ts';
import { copilotRawModelId } from '../../model-name.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent, AnthropicMessagesThinkingDisplay } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

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

export const resolveAnthropicMessagesDownstreamThinkingDisplay = (ctx: { payload: AnthropicMessagesPayload }): AnthropicMessagesThinkingDisplay | undefined => {
  const display = ctx.payload.thinking?.display;
  if (display !== undefined) {
    // Request JSON is not runtime-validated before boundary stages; leave
    // unknown display values untouched so upstream, not this workaround, owns
    // rejecting or accepting future values.
    return isAnthropicMessagesThinkingDisplay(display) ? display : undefined;
  }

  return isClaudeVersionAtLeast(ctx.payload.model, 4, 7) ? 'omitted' : 'summarized';
};

const omitThinkingTextFromProtocolFrame = (frame: ProtocolFrame<AnthropicMessagesStreamEvent>): ProtocolFrame<AnthropicMessagesStreamEvent> | undefined => {
  if (frame.type === 'done') return frame;

  const { event } = frame;
  if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
    return eventFrame({
      ...event,
      content_block: {
        ...event.content_block,
        thinking: '',
      },
    });
  }

  if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
    return undefined;
  }

  return frame;
};

const omitThinkingTextFromProtocolFrames = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {
  for await (const frame of frames) {
    const omitted = omitThinkingTextFromProtocolFrame(frame);
    if (omitted) yield omitted;
  }
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
 * downstream omitted semantics, this boundary stage removes only thinking
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

export const copilotAnthropicMessagesThinkingDisplay = defineStage<MessagesFacts, MessagesFacts, ProviderChatResponse<'anthropicMessages'>, ProviderChatResponse<'anthropicMessages'>, ProviderChatServices>({
  name: 'copilotAnthropicMessagesThinkingDisplay',
  through: { request: { needs: ['request.provider.payload'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] }, response: { needs: ['response.provider.output'], consumes: ['response.provider.output'], provides: ['response.provider.output'] } },
  execute: async (facts, next, use) => {
    let payload = facts['request.provider.payload'];
    const display = resolveAnthropicMessagesDownstreamThinkingDisplay({ payload });
    const thinking = payload.thinking;
    const active = !!thinking && thinking.type !== 'disabled';
    const stamp = active && display === 'omitted';
    if (active && display !== undefined && display !== 'full') payload = { ...payload, thinking: { ...thinking, display: 'summarized' } };
    const back = await next(move({ ...facts, 'request.provider.payload': payload }));
    const output = back['response.provider.output'];
    if (!stamp || output === null || !('kind' in output) || output.kind !== 'stream') return move({ ...back });
    return move({ ...back, 'response.provider.output': { ...output, frames: use.recordProtocolFrames(omitThinkingTextFromProtocolFrames(output.frames)) } });
  },
});
