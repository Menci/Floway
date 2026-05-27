import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { ChatCompletionsInvocation, RequestContext } from '../../../interceptors.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

export { stubProvider, stubUpstreamModel, testTelemetryModelIdentity };

export const chatCompletionsInvocation = (payload: ChatCompletionsPayload, enabledFlags: ReadonlySet<string> = new Set()): ChatCompletionsInvocation => ({
  sourceApi: 'chat-completions',
  targetApi: 'chat-completions',
  model: payload.model,
  upstream: 'test-upstream',
  upstreamModel: stubUpstreamModel(),
  provider: stubProvider(),
  enabledFlags,
  payload,
  headers: {},
});

export const stubRequestContext: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};
