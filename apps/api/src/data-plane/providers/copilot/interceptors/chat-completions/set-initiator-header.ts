import type { ChatCompletionsInterceptor } from '../../../../llm/interceptors.ts';

/**
 * Copilot's `x-initiator` header distinguishes user-triggered turns from
 * agent-triggered tool-result consumption. On Chat Completions the
 * discriminator is the last message: when its role is `assistant` (model
 * replay) or `tool` (a tool result being fed back into the model), the agent
 * is driving the turn. Every other role (`user`, `system`, `developer`) means
 * the user just spoke.
 *
 * The header name is lowercase `x-initiator`; HTTP header names are
 * case-insensitive on the wire, so the casing is cosmetic.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/services/copilot/create-chat-completions.ts#L32-L44
 */
export const withInitiatorHeaderSet: ChatCompletionsInterceptor = async (ctx, _request, run) => {
  const lastMessage = ctx.payload.messages.at(-1);
  const initiator: 'user' | 'agent' = lastMessage?.role === 'assistant' || lastMessage?.role === 'tool' ? 'agent' : 'user';
  ctx.headers['x-initiator'] = initiator;

  return await run();
};
