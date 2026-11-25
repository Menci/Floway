import type { OpenAIResponsesOperation } from './operations.ts';
import { rewriteHeaders } from '../shared/rewrite-request.ts';
import { setHeader } from '@floway-dev/http';

/**
 * Copilot's `x-initiator` header distinguishes user-triggered turns from
 * agent-triggered tool-result consumption. On OpenAI Responses the discriminator is
 * the last input item — but the set of "agent" shapes is broader than just
 * `function_call_output`:
 *
 * - Tool-output-style items lack a `role` field entirely
 *   (`function_call_output`, `custom_tool_call_output`, `tool_search_output`,
 *   plus any future hosted-tool output shape). Classify them as agent.
 * - An assistant message replayed back into `input` is also agent-driven.
 *
 * Role-bearing user / system / developer items — including the canonical
 * `additional_tools` developer item — and an empty input mean initiator = user.
 *
 * The header name is lowercase `x-initiator`; HTTP header names are
 * case-insensitive on the wire, so the casing is cosmetic.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/cd8207cb70ede07771bf37a04accfbf2af76d980/src/routes/responses/utils.ts#L75-L87
 *   (`hasAgentInitiator`)
 */

export const setInitiatorHeader = (operation: OpenAIResponsesOperation) => rewriteHeaders[operation]('setInitiatorHeader', (payload, headers) => {
  const last = payload.input.at(-1);
  const role = (last as { role?: unknown } | undefined)?.role;
  const agent = last !== undefined && (role === undefined || role === null || role === '' || role === 'assistant');
  return setHeader(headers, 'x-initiator', agent ? 'agent' : 'user');
});
