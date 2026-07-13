import type { CopilotChatCompletionsBoundaryInterceptor } from './types.ts';
import { CHAT_COMPLETIONS_INTERNAL_METADATA } from '@floway-dev/protocols/chat-completions';

/**
 * Copilot's `x-initiator` header distinguishes user-triggered turns from
 * agent-triggered tool-result consumption. On Chat Completions the
 * discriminator is the last message: when its role is `assistant` (model
 * replay) or `tool` (a tool result being fed back into the model), the agent
 * is driving the turn. Responses tool-output images are the exception to the
 * role check: Chat tool messages cannot carry images, so translation lifts
 * them into a final user message after the contiguous tool results; that
 * synthesized message retains the source turn's agent initiator through
 * symbol-keyed internal metadata that direct JSON clients cannot supply and
 * JSON wire serialization cannot expose.
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
    || ctx.payload[CHAT_COMPLETIONS_INTERNAL_METADATA]?.liftedToolOutputImages === true;
  ctx.headers.set('x-initiator', agentInitiated ? 'agent' : 'user');

  return await run();
};
