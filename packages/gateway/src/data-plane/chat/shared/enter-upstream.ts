import type { ChatEgressInput, ChatPayload, ChatProtocolExtras } from './route-body.ts';
import type { HttpInput } from '../../pipeline/edge-http.ts';
import type { CandidateRequest } from '../../pipeline/failover.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import type { UpstreamFacts } from '../../providers/upstreams.ts';
import { defineEnding, type Next, type StaticTarget, type TargetMap, type ThroughDecl } from '@floway-dev/pipeline';
import type { ChatTargetApi, ProviderBaseOutput, ProviderInput, ProviderPipelines } from '@floway-dev/provider';

type Kind = UpstreamFacts['kind'];
type ForKind<K extends Kind> = Extract<UpstreamFacts, { readonly kind: K }>;

export type ProviderTargets<Payload, Output, Extras> = {
  readonly [K in Kind]?: StaticTarget<ProviderInput<ForKind<K>, Payload> & Extras, Output, GatewayServices>;
};

type ProviderCalls<Payload, Output, Extras> = {
  readonly [K in Kind]?: Next<ProviderInput<ForKind<K>, Payload> & Extras, Output>;
};

export const createProviderEnding = <
  Input extends HttpInput & CandidateRequest,
  Payload,
  Output extends ProviderBaseOutput,
  Extras extends object,
>(
  outcomeKey: string,
  targets: TargetMap<GatewayServices> & ProviderTargets<Payload, Output, Extras>,
  prepare: (facts: Input) => { readonly 'request.payload': Payload } & Extras,
  extraNeeds: readonly string[] = [],
) => {
  const declaration: ThroughDecl = {
    request: { needs: [], consumes: [], provides: ['provider.upstream', 'provider.model', 'request.payload'] },
    response: { needs: ['response.http', 'response.modelKey', outcomeKey], consumes: [], provides: [] },
  };
  const into = Object.fromEntries(Object.keys(targets).map(kind => [kind, declaration]));
  return defineEnding<Input, Output, TargetMap<GatewayServices>, GatewayServices>({
    name: 'enterUpstream',
    request: { needs: ['request.http', 'request.payload', 'route.candidate', ...extraNeeds] },
    into,
    execute: async (facts, scope) => {
      const candidate = facts['route.candidate'];
      const upstream = candidate.upstream;
      const request = { ...facts, ...prepare(facts), 'provider.model': candidate.providerModel };
      const calls: ProviderCalls<Payload, Output, Extras> = scope.into;
      switch (upstream.kind) {
      case 'azure': if (calls.azure) return await calls.azure({ ...request, 'provider.upstream': upstream }); break;
      case 'chatgpt': if (calls.chatgpt) return await calls.chatgpt({ ...request, 'provider.upstream': upstream }); break;
      case 'claude-code': if (calls['claude-code']) return await calls['claude-code']({ ...request, 'provider.upstream': upstream }); break;
      case 'copilot': if (calls.copilot) return await calls.copilot({ ...request, 'provider.upstream': upstream }); break;
      case 'custom': if (calls.custom) return await calls.custom({ ...request, 'provider.upstream': upstream }); break;
      case 'kimi-code': if (calls['kimi-code']) return await calls['kimi-code']({ ...request, 'provider.upstream': upstream }); break;
      case 'ollama': if (calls.ollama) return await calls.ollama({ ...request, 'provider.upstream': upstream }); break;
      }
      throw new Error(`Upstream ${upstream.id} does not support ${outcomeKey}`);
    },
  });
};

type ChatOperation = ChatTargetApi | 'anthropicMessagesCountTokens' | 'geminiGenerateContentCountTokens';
type ChatApi<Operation extends ChatOperation> =
  Operation extends 'anthropicMessagesCountTokens' ? 'anthropicMessages' :
    Operation extends 'geminiGenerateContentCountTokens' ? 'geminiGenerateContent' : Operation;
type ProviderOutput<Operation extends ChatOperation> =
  NonNullable<ProviderPipelines[Operation]> extends StaticTarget<infer _Input, infer Output extends ProviderBaseOutput, infer _Services>
    ? Output : never;

export const createChatProviderEnding = <
  Api extends ChatOperation,
  Targets extends TargetMap<GatewayServices>,
>(
  api: Api,
  targets: Targets & ProviderTargets<Omit<ChatPayload<ChatApi<Api>>, 'model'>, ProviderOutput<Api>, ChatProtocolExtras<ChatApi<Api>>>,
) => createProviderEnding<ChatEgressInput<ChatApi<Api>>, Omit<ChatPayload<ChatApi<Api>>, 'model'>, ProviderOutput<Api>, ChatProtocolExtras<ChatApi<Api>>>(
  `response.${api}`,
  targets,
  facts => {
    const { model: _model, ...payload } = facts['request.payload'];
    return { ...facts, 'request.payload': payload };
  },
  api === 'openaiResponses' ? ['request.action']
    : api === 'anthropicMessages' || api === 'anthropicMessagesCountTokens' ? ['request.anthropicBeta'] : [],
);
