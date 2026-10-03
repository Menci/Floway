import type { OpenAIResponsesInterceptor } from './types.ts';
import { agentMessageContent } from '../items/agent-message-content.ts';
import { providerModelOf } from '@floway-dev/provider';

// Codex delivers sub-agent tasks and inter-agent messages as `agent_message`
// input items. Only a native OpenAI Responses upstream can understand the item,
// and some Responses-compatible upstreams drop or reject it, so a spawned
// sub-agent never sees its task. Lower each item to a user message whose
// content frames the payload as coming from another agent, keeping the
// user-role wire slot from granting user authority.
//
// The lowering is mandatory when the target protocol is not OpenAI Responses
// (the translators do not know the item) and opt-in through
// `openai-responses-agent-message-shim` on a native target, which otherwise
// receives the item untouched.
// https://github.com/openai/codex/blob/0a2eb4696c26ac33204bcd255721ab30220a4774/codex-rs/protocol/src/models.rs#L1036-L1046
export const withOpenAIResponsesAgentMessageShim: OpenAIResponsesInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi === 'openaiResponses'
    && !providerModelOf(ctx.candidate).enabledFlags.has('openai-responses-agent-message-shim')) return run();
  if (!ctx.payload.input.some(item => item.type === 'agent_message')) return run();

  ctx.payload = {
    ...ctx.payload,
    input: ctx.payload.input.map(item => item.type === 'agent_message'
      ? { type: 'message', role: 'user', content: agentMessageContent(item) }
      : item),
  };
  return run();
};
