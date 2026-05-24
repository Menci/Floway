// Kimi (Moonshot) wire-dialect normalizer for Chat Completions.
// Always-attached; flag-gated by `vendor-kimi`. Runs last among target
// interceptors so it has the first say on the inbound stream.
//
// Outbound: nothing today — Kimi accepts the OpenAI-canonical request shape
// the gateway emits.
//
// Inbound (stream → client):
//
// - Each usage chunk: remap the flat `cached_tokens` field into OpenAI's
//   `prompt_tokens_details.cached_tokens`. Generic interceptors upstream of
//   this one then see the standard shape.
//
// Reference:
// - https://platform.kimi.com/docs/api/chat

import { asJsonObject, type JsonObject, readJsonNumber } from '../../../../../shared/json-helpers.ts';
import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';
import type { ChatCompletionChunk } from '@floway-dev/protocols/chat-completions';
import { eventFrame } from '@floway-dev/protocols/common';

const rewriteInboundUsage = (chunk: ChatCompletionChunk): ChatCompletionChunk => {
  const usage = asJsonObject(chunk.usage);
  if (!usage) return chunk;
  const cached = readJsonNumber(usage.cached_tokens);
  if (cached == null) return chunk;

  const { cached_tokens: _stripped, ...rest } = usage;
  const next: JsonObject = {
    ...rest,
    prompt_tokens_details: {
      ...(asJsonObject(usage.prompt_tokens_details) ?? {}),
      cached_tokens: cached,
    },
  };
  return { ...chunk, usage: next as unknown as ChatCompletionChunk['usage'] };
};

export const withVendorKimiChatCompletionsNormalize: ChatCompletionsInterceptor = async (ctx, _request, run) => {
  if (!ctx.enabledFlags.has('vendor-kimi')) return await run();

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
        const event = rewriteInboundUsage(frame.event);
        yield event === frame.event ? frame : eventFrame(event);
      }
    })(),
  };
};
