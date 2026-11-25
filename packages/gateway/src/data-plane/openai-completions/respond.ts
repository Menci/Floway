import type { TokenUsage } from '../../repo/types.ts';
import { openaiSseFailure } from '../shared/openai-errors.ts';
import { passthroughApiError, type PassthroughResponseStrategyContext } from '../shared/passthrough-serve.ts';
import { serializeSseFrame, serveSse } from '../shared/sse.ts';
import { recordFailedRequest } from '../shared/telemetry/performance.ts';
import { recordSseOutcome, settle } from '../shared/telemetry/settle.ts';
import { forwardUpstreamHeaders, forwardUpstreamResponse } from '../shared/upstream-response.ts';
import { eventFrame, isOpenAIErrorPayload, type ProtocolFrame, sseFrame } from '@floway-dev/protocols/common';
import { parseOpenAICompletionsStream } from '@floway-dev/protocols/openai-completions';

export const respondOpenAICompletionsSse = (
  { c, ctx, sourceApi, response, performance, identity }: PassthroughResponseStrategyContext,
  transformFrame: (frame: ProtocolFrame<unknown>) => ProtocolFrame<unknown> | null,
  settleUsage: () => TokenUsage | null,
): Response => {
  if (!response.ok) {
    recordFailedRequest(ctx, performance);
    ctx.dump?.error('upstream', identity.upstream);
    return forwardUpstreamResponse(response);
  }
  if (!response.body) {
    ctx.dump?.failed(`${sourceApi} streaming upstream returned no body`);
    recordFailedRequest(ctx, performance);
    forwardUpstreamHeaders(c, response.headers);
    return passthroughApiError(c, 'Upstream returned a streaming response with no body.', 502);
  }

  return serveSse(c, {
    http: response,
    events: parseOpenAICompletionsStream(response.body, { signal: ctx.abortSignal }),
    downstreamAbortController: ctx.downstreamAbortController,
    protocol: {
      encode: input => {
        if (input.type === 'error') {
          const { cause } = input.cause;
          if (!isOpenAIErrorPayload(cause)) throw new Error(input.cause.message, { cause });
          ctx.dump?.frame(eventFrame(cause));
          return { wire: serializeSseFrame(sseFrame(JSON.stringify(cause))), end: { type: 'protocol-error' } };
        }
        ctx.dump?.frame(input);
        if (input.type === 'done') return { wire: serializeSseFrame(sseFrame('[DONE]')), end: { type: 'completed' } };
        const output = transformFrame(input);
        return { wire: output?.type === 'event' ? serializeSseFrame(sseFrame(JSON.stringify(output.event))) : null };
      },
      eof: () => ({ type: 'premature-eof', error: new Error('OpenAI Completions stream ended without a [DONE] sentinel.') }),
      failure: error => openaiSseFailure(ctx, error),
    },
    settle: outcome => {
      const usage = settleUsage();
      const failed = recordSseOutcome(ctx, outcome, identity, usage);
      settle(ctx, performance, identity, usage, failed);
    },
  });
};
