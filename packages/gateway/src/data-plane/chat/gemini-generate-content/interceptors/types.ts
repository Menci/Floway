import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { ApiErrorResult, ExecuteResult, GeminiGenerateContentInvocation, PlainResult } from '@floway-dev/provider';

export type GeminiGenerateContentInterceptor = Interceptor<
  GeminiGenerateContentInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<GeminiGenerateContentStreamEvent>>
>;

// countTokens returns a reshaped HTTP body or an API error. The interceptor
// chain still uses GeminiGenerateContentInvocation so payload-shaped reads
// stay symmetric with the generate path. Interceptors
// registered here MUST be pure header/payload mutators; post-`run()` result
// inspection is not portable to this result type.
export type GeminiGenerateContentCountTokensInterceptor = Interceptor<
  GeminiGenerateContentInvocation,
  GatewayCtx,
  ApiErrorResult | PlainResult
>;
