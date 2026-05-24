import { responsesStreamFramesToEvents } from './events/from-stream.ts';
import { responsesBaseInterceptors } from './interceptors/index.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import { type RequestContext, type ResponsesInvocation, runInterceptors } from '../../interceptors.ts';
import { eventResult, type ExecuteResult } from '../../shared/errors/result.ts';
import { targetInternalError, targetModelIdentity, targetProviderResultToFrames } from '../emit.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const targetApi = 'responses';

export const emitToResponses = async (invocation: ResponsesInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, [...responsesBaseInterceptors, ...(invocation.targetInterceptors?.responses ?? [])], async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body }: ResponsesPayload = invocation.payload;
      const providerResult = await invocation.provider.callResponses(invocation.upstreamModel, body, request.downstreamAbortSignal);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      const result = await targetProviderResultToFrames(invocation, request, targetApi, providerResult, modelIdentity, upstreamStartedAt);

      return result.type === 'events' ? eventResult(responsesStreamFramesToEvents(result.events), result.modelIdentity, result.performance, result.finalMetadata) : result;
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};
