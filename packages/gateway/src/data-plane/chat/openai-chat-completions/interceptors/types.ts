import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIChatCompletionsInvocation, ExecuteResult } from '@floway-dev/provider';

export type { OpenAIChatCompletionsInvocation };

export type OpenAIChatCompletionsInterceptor = Interceptor<
  OpenAIChatCompletionsInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>
>;
