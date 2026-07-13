import type { CopilotChatCompletionsBoundaryInterceptor } from './types.ts';
import type { ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';

const TOOL_OUTPUT_IMAGE_LABEL = /^Image output from tool call (.+):$/;

const isLiftedToolOutputImageMessage = (messages: ChatCompletionsMessage[]): boolean => {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== 'user' || !Array.isArray(lastMessage.content)) return false;

  const callIds = new Set<string>();
  let hasImage = false;
  for (const part of lastMessage.content) {
    if (part.type === 'image_url') {
      hasImage = true;
      continue;
    }
    const match = TOOL_OUTPUT_IMAGE_LABEL.exec(part.text);
    if (match === null) return false;
    callIds.add(match[1]);
  }
  if (!hasImage || callIds.size === 0) return false;

  const precedingToolCallIds = new Set<string>();
  for (let i = messages.length - 2; i >= 0 && messages[i].role === 'tool'; i--) {
    const callId = messages[i].tool_call_id;
    if (callId !== undefined) precedingToolCallIds.add(callId);
  }
  return [...callIds].every(callId => precedingToolCallIds.has(callId));
};

/**
 * Copilot's `x-initiator` header distinguishes user-triggered turns from
 * agent-triggered tool-result consumption. On Chat Completions the
 * discriminator is the last message: when its role is `assistant` (model
 * replay) or `tool` (a tool result being fed back into the model), the agent
 * is driving the turn. Responses tool-output images are the exception to the
 * role check: Chat tool messages cannot carry images, so translation lifts
 * them into a final user message after the contiguous tool results; that
 * synthesized message retains the source turn's agent initiator.
 *
 * The header name is lowercase `x-initiator`; HTTP header names are
 * case-insensitive on the wire, so the casing is cosmetic.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/cd0d0182eb4b9bf68a3376dc79728afa7f42ce07/src/services/copilot/create-chat-completions.ts#L28-L49
 * - https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts#L1893-L1908
 */
export const withInitiatorHeaderSet: CopilotChatCompletionsBoundaryInterceptor = async (ctx, _request, run) => {
  const lastMessage = ctx.payload.messages.at(-1);
  const agentInitiated = lastMessage?.role === 'assistant'
    || lastMessage?.role === 'tool'
    || isLiftedToolOutputImageMessage(ctx.payload.messages);
  ctx.headers.set('x-initiator', agentInitiated ? 'agent' : 'user');

  return await run();
};
