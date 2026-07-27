import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatCompletionsInvocation, ExecuteResult } from '@floway-dev/provider';

export type { ChatCompletionsInvocation };

export type ChatCompletionsInterceptor = Interceptor<
  ChatCompletionsInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>
>;
