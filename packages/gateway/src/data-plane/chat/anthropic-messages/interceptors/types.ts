import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { Interceptor, InterceptorRun } from '@floway-dev/interceptor';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult, AnthropicMessagesInvocation } from '@floway-dev/provider';

export type { AnthropicMessagesInvocation };

export type AnthropicMessagesInterceptor = Interceptor<
  AnthropicMessagesInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>>
>;

// count_tokens is a one-shot, non-streaming HTTP exchange whose terminal
// returns the raw upstream `Response`. Shared entries must therefore be pure
// header/payload mutators; post-run stream inspection is not portable to this
// result type.
export type AnthropicMessagesCountTokensInterceptor = Interceptor<
  AnthropicMessagesInvocation,
  GatewayCtx,
  Response
>;

// Payload-only transforms can run in both the streaming generation chain and
// the one-shot count_tokens chain. Keeping the result generic prevents those
// shared interceptors from accidentally inspecting either result shape.
export type AnthropicMessagesPayloadInterceptor = <TResult>(
  ctx: AnthropicMessagesInvocation,
  gatewayCtx: GatewayCtx,
  run: InterceptorRun<TResult>,
) => Promise<TResult>;
