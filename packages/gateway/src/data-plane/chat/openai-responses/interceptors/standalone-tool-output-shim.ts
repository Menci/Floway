import type { OpenAIResponsesInterceptor } from './types.ts';
import { tryCatchChatServeFailure, type InputErrorDetails } from '../../shared/errors.ts';
import { inputErrorResult } from '../errors.ts';
import { standaloneToolOutputContent } from '../items/standalone-tool-output-content.ts';
import { providerModelOf } from '@floway-dev/provider';

// Codex injects client context (the `/goal` objective, companion pages,
// automation and delegation bootstraps) as `function_call_output` items with a
// `name` and `namespace` but no `call_id`. OpenAI accepts such a standalone
// output; strict Responses-compatible upstreams reject the whole request, and
// the translators cannot express a tool result that answers no call. Lower each
// standalone output to a user message carrying its content as external context.
//
// The lowering is mandatory when the target protocol is not OpenAI Responses
// and opt-in through `openai-responses-standalone-tool-output-shim` on a native
// target, which otherwise receives the item untouched.
// https://github.com/openai/codex/blob/8011b92bc82d4cc1b6dc3f35c0cd28768c797c97/codex-rs/context-fragments/src/additional_context.rs#L35-L46
// https://github.com/openai/codex/issues/42088
export const withOpenAIResponsesStandaloneToolOutputShim: OpenAIResponsesInterceptor = async (ctx, gatewayCtx, run) => {
  if (ctx.targetApi === 'openaiResponses'
    && !providerModelOf(ctx.candidate).enabledFlags.has('openai-responses-standalone-tool-output-shim')) return await run();
  if (!ctx.payload.input.some(item => item.type === 'function_call_output' && item.call_id == null)) return await run();

  try {
    ctx.payload = {
      ...ctx.payload,
      input: ctx.payload.input.map((item, index) => item.type === 'function_call_output' && item.call_id == null
        ? { type: 'message', role: 'user', content: standaloneToolOutputContent(item, index) }
        : item),
    };
  } catch (error) {
    const failure = tryCatchChatServeFailure<InputErrorDetails & { readonly kind: 'invalid-input' }>(error);
    if (failure === null) throw error;
    return inputErrorResult(failure, gatewayCtx.attempt.telemetry);
  }
  return await run();
};
