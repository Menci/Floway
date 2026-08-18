import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import type { ExecuteResult, OpenAIResponsesInvocation } from '@floway-dev/provider';

export type { OpenAIResponsesInvocation };

export type OpenAIResponsesInterceptor = Interceptor<
  OpenAIResponsesInvocation,
  ChatGatewayCtx,
  ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>>
>;
