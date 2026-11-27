import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { Interceptor, InterceptorRun } from '@floway-dev/interceptor';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ApiErrorResult, ExecuteResult, AnthropicMessagesInvocation, PlainResult } from '@floway-dev/upstream';

export type { AnthropicMessagesInvocation };

export type AnthropicMessagesInterceptor = Interceptor<
  AnthropicMessagesInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>>
>;

// count_tokens returns an upstream-shaped HTTP body or an API error. Shared
// entries must remain pure header/payload mutators; post-run stream inspection
// is not portable to this result type.
export type AnthropicMessagesCountTokensInterceptor = Interceptor<
  AnthropicMessagesInvocation,
  GatewayCtx,
  ApiErrorResult | PlainResult
>;

// Payload-only transforms can run in both the streaming generation chain and
// the one-shot count_tokens chain. Keeping the result generic prevents those
// shared interceptors from accidentally inspecting either result shape.
export type AnthropicMessagesPayloadInterceptor = <TResult>(
  ctx: AnthropicMessagesInvocation,
  gatewayCtx: GatewayCtx,
  run: InterceptorRun<TResult>,
) => Promise<TResult>;
