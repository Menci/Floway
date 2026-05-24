import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload, ChatReasoningItem, Message } from '@floway-dev/protocols/chat-completions';
import { eventFrame } from '@floway-dev/protocols/common';

/**
 * DeepSeek's reasoner endpoints expose thinking text through the legacy
 * `reasoning_content` scalar both in responses and in the assistant messages a
 * client must replay during multi-turn tool calls. The gateway's internal
 * protocol is the OpenAI shape, so on upstreams with this flag enabled we
 * rename fields on the way out (`reasoning_text` → `reasoning_content`) and on
 * the way back in (`reasoning_content` → `reasoning_text`).
 *
 * This is required for correctness, not just aesthetics: DeepSeek documents
 * `reasoning_content` as part of the assistant message clients replay during
 * multi-turn tool-call loops, and its integration notes report 400s when that
 * field is omitted.
 *
 * Gating: bound to the `deepseek-reasoning-dialect` flag (declared in
 * ../../../../providers/flags.ts). The interceptor is always attached to the
 * Chat Completions target list and early-returns inside its body when the
 * flag is not set on the invocation.
 *
 * References:
 * - https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 * - https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
 */

type DeepseekReasoningDelta = ChatCompletionChunk['choices'][number]['delta'] & {
  reasoning_content?: unknown;
};

// Synthesize a scalar reasoning text from reasoning_items summaries. Used
// when the client replays the newer OpenAI shape (reasoning_items only,
// no scalar reasoning_text).
const synthesizeFromItems = (items: ChatReasoningItem[] | null | undefined): string | undefined => {
  if (!items?.length) return undefined;
  const parts = items.flatMap(item => item.summary?.map(s => s.text) ?? []);
  return parts.length > 0 ? parts.join('') : undefined;
};

const rewriteOutboundMessage = (message: Message): Message => {
  // DeepSeek documents only the scalar reasoning_content field. Strip the
  // OpenAI-only fields regardless of whether reasoning_text is present; when
  // reasoning_text is absent, synthesize from reasoning_items summaries so the
  // visible reasoning chain survives the dialect hop.
  const { reasoning_text, reasoning_opaque: _opaque, reasoning_items, ...rest } = message;

  const text = typeof reasoning_text === 'string' ? reasoning_text : synthesizeFromItems(reasoning_items);

  if (text === undefined) return rest as Message;
  return { ...rest, reasoning_content: text } as Message;
};

const rewriteOutboundPayload = (payload: ChatCompletionsPayload): ChatCompletionsPayload => ({
  ...payload,
  messages: payload.messages.map(rewriteOutboundMessage),
});

const rewriteInboundChunk = (chunk: ChatCompletionChunk): ChatCompletionChunk => {
  let changed = false;
  const choices = chunk.choices.map(choice => {
    const delta = choice.delta as DeepseekReasoningDelta;
    if (typeof delta.reasoning_content !== 'string') return choice;

    const { reasoning_content, ...rest } = delta;
    changed = true;
    return {
      ...choice,
      delta: {
        ...rest,
        ...(delta.reasoning_text === undefined ? { reasoning_text: reasoning_content } : {}),
      },
    };
  });

  return changed ? { ...chunk, choices } : chunk;
};

export const withDeepseekReasoningDialect: ChatCompletionsInterceptor = async (ctx, _request, run) => {
  if (!ctx.enabledFlags.has('deepseek-reasoning-dialect')) return await run();

  ctx.payload = rewriteOutboundPayload(ctx.payload);

  const result = await run();
  if (result.type !== 'events') return result;

  return {
    ...result,
    events: (async function* () {
      for await (const frame of result.events) {
        if (frame.type !== 'event') {
          yield frame;
          continue;
        }

        const event = rewriteInboundChunk(frame.event);
        yield event === frame.event ? frame : eventFrame(event);
      }
    })(),
  };
};
