import type { MessagesInvocation, RequestContext } from '../../../../llm/interceptors.ts';

/**
 * Copilot's `x-initiator` header distinguishes turns that the human user just
 * triggered (`user`) from turns the agent triggered to consume a tool result
 * (`agent`). The header gates Copilot-side abuse controls and conversation
 * accounting. We classify by the last message: a user turn whose content
 * mixes plain blocks with tool_results is still user-initiated; a user turn
 * whose content is *only* tool_results is the agent consuming results, and
 * any assistant-final turn (which only happens on count-tokens replays) is
 * always agent.
 *
 * The header name is lowercase `x-initiator`; HTTP header names are
 * case-insensitive on the wire, so the casing is cosmetic.
 *
 * Generic in the run-result type so the count_tokens target chain
 * (`Response`) and the streaming Messages target chain (`ExecuteResult<...>`)
 * can share one definition, matching the pre-Path A behavior where
 * x-initiator was set on every Copilot Messages HTTP call.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/master/src/services/copilot/create-chat-completions.ts
 */
export const withInitiatorHeaderSet = async <TResult>(ctx: MessagesInvocation, _request: RequestContext, run: () => Promise<TResult>): Promise<TResult> => {
  const lastMessage = ctx.payload.messages[ctx.payload.messages.length - 1];
  let initiator: 'user' | 'agent';
  if (lastMessage?.role !== 'user') {
    initiator = 'agent';
  } else if (!Array.isArray(lastMessage.content)) {
    initiator = 'user';
  } else {
    initiator = lastMessage.content.some(block => block.type !== 'tool_result') ? 'user' : 'agent';
  }
  ctx.headers['x-initiator'] = initiator;

  return await run();
};
