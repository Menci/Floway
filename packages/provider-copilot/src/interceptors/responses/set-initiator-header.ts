import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';

/**
 * Copilot's `x-initiator` header distinguishes user-triggered turns from
 * agent-triggered tool-result consumption. On Responses the discriminator is
 * the last input item — but the set of "agent" shapes is broader than just
 * `function_call_output`:
 *
 * - Any tool-output-style item lacks a `role` field entirely
 *   (`function_call_output`, `custom_tool_call_output`, `tool_search_output`,
 *   plus any future hosted-tool output shape). Classify all of them as agent.
 * - An assistant message replayed back into `input` is also agent-driven.
 *
 * User / system / developer messages, or no input item, mean the user just
 * spoke, so initiator = user.
 *
 * The header name is lowercase `x-initiator`; HTTP header names are
 * case-insensitive on the wire, so the casing is cosmetic.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/cd8207cb70ede07771bf37a04accfbf2af76d980/src/routes/responses/utils.ts#L75-L87
 *   (`hasAgentInitiator`)
 */
export const withInitiatorHeaderSet = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const lastItem: ResponsesInputItem | undefined = ctx.payload.input.at(-1);
  const initiator: 'user' | 'agent' = lastItem !== undefined && (lastItem.type !== 'message' || lastItem.role === 'assistant') ? 'agent' : 'user';
  ctx.headers.set('x-initiator', initiator);

  return await run();
};
