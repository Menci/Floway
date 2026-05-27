import type { ResponsesInterceptor } from '../../../../llm/interceptors.ts';
import type { ResponseInputItem } from '@floway-dev/protocols/responses';

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
 * Everything else (user / system / developer messages, plain string input)
 * means the user just spoke, so initiator = user.
 *
 * The header name is lowercase `x-initiator`; HTTP header names are
 * case-insensitive on the wire, so the casing is cosmetic.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/routes/responses/utils.ts#L60-L73
 *   (`hasAgentInitiator`)
 */
const isAgentInitiated = (lastItem: ResponseInputItem | undefined): boolean => {
  if (!lastItem) return false;
  // Items that do not carry a `role` field at all are tool/system outputs the
  // agent is feeding back into the model.
  const record = lastItem as { role?: unknown };
  if (!('role' in record) || record.role === undefined || record.role === null || record.role === '') return true;
  return typeof record.role === 'string' && record.role.toLowerCase() === 'assistant';
};

export const withInitiatorHeaderSet: ResponsesInterceptor = async (ctx, _request, run) => {
  const input = ctx.payload.input;
  const initiator: 'user' | 'agent' = Array.isArray(input) && isAgentInitiated(input.at(-1)) ? 'agent' : 'user';
  ctx.headers['x-initiator'] = initiator;

  return await run();
};
