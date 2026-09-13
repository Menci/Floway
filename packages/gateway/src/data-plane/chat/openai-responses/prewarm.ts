import { openaiResponsesCreatedAt } from './client-output.ts';
import { openaiResponsesInputErrorResult } from './errors.ts';
import { createOpenAIResponsesResponseId } from './response-id.ts';
import { completeResponseResource } from './response-resource.ts';
import { prepareOpenAIResponsesServePlan, type OpenAIResponsesServePlan } from './serve-prep.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { OpenAIResponsesLiteInputError, openAIResponsesTransportForRequest, type CanonicalOpenAIResponsesPayload, type ClientOpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

type OpenAIResponsesPrewarmResult =
  | Extract<OpenAIResponsesServePlan, { kind: 'failure' }>
  | { readonly kind: 'prepared'; readonly events: readonly ClientOpenAIResponsesStreamEvent[] };

// WebSocket generate=false prepares chainable request state without model
// output. The gateway owns that state, so no HTTP inference call is needed.
// https://developers.openai.com/api/docs/guides/websocket-mode
export const prewarmOpenAIResponses = async (args: {
  readonly payload: CanonicalOpenAIResponsesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}): Promise<OpenAIResponsesPrewarmResult> => {
  const { payload, ctx, headers } = args;
  try {
    openAIResponsesTransportForRequest(payload, headers);
  } catch (error) {
    if (!(error instanceof OpenAIResponsesLiteInputError)) throw error;
    return { kind: 'failure', result: openaiResponsesInputErrorResult({ message: error.message, param: error.param, code: 'invalid_value' }) };
  }
  const plan = await prepareOpenAIResponsesServePlan({ payload, ctx });
  if (plan.kind === 'failure') return plan;

  const id = createOpenAIResponsesResponseId();
  await ctx.store.commitSnapshot(id, 'append', []);
  const sources = { request: payload, createdAt: openaiResponsesCreatedAt(ctx), stored: ctx.store.writesState };
  const completed = completeResponseResource({
    id, object: 'response', model: payload.model, status: 'completed', output: [], output_text: '', error: null, incomplete_details: null,
  }, sources, true);
  return {
    kind: 'prepared',
    events: [
      { type: 'response.created', sequence_number: 0, response: completeResponseResource({ ...completed, status: 'in_progress' }, sources, false) },
      { type: 'response.completed', sequence_number: 1, response: completed },
    ],
  };
};
