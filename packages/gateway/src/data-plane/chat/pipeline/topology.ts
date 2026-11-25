import type { ChatDelivery } from './delivery.ts';
import { gatewayFactSpace, httpEntry, type ServeCandidate } from '../../pipeline/facts.ts';
import { providerSupportsOperation } from '../../pipeline/provider-pipelines.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import type { Pipeline } from '@floway-dev/pipeline';

export type ChatProtocol = ChatDelivery['kind'];
export type ChatRequestKey<Protocol extends ChatProtocol> = `request.${Protocol}`;
export type ChatResponseKey<Protocol extends ChatProtocol> = `response.${Protocol}`;

type ChatPipeline = Pipeline<never, unknown, GatewayServices>;
type ChatTarget = ChatPipeline | (() => ChatPipeline);

const { defineStage } = gatewayFactSpace<GatewayServices>();

export const chatBodyEntry = <const Protocol extends ChatProtocol>(protocol: Protocol) =>
  [...httpEntry, 'serve.candidate', `request.${protocol}`] as const;

export const chatEgressEntry = <const Protocol extends ChatProtocol>(protocol: Protocol) =>
  ['request.http', 'request.auth.apiKeyId', 'serve.candidate', `request.${protocol}`] as const;

export const chatBodyExit = <const Protocol extends ChatProtocol>(protocol: Protocol) =>
  ['response.http', `response.${protocol}`] as const;

const preserveChatFacts = (protocol: ChatProtocol) => ({
  request: { needs: chatBodyEntry(protocol), provides: [], consumes: [] },
  response: { needs: chatBodyExit(protocol), provides: [], consumes: [] },
} as const);

export const enterChatBody = (protocol: ChatProtocol, body: ChatTarget) => ({
  ending: defineStage({
    name: `${protocol}.enter-body`,
    request: { needs: chatBodyEntry(protocol) },
    into: { body: preserveChatFacts(protocol) },
    async execute(facts, scope) {
      return await scope.into.body(facts);
    },
  }),
  targets: { body },
});

export const chatBodyTargets = <const Protocol extends ChatProtocol>(
  protocol: Protocol,
  egress: ChatTarget,
  translations: readonly (readonly [Exclude<ChatProtocol, NoInfer<Protocol>>, ChatTarget])[],
) => {
  const preference = [protocol, ...translations.map(([target]) => target)];
  const targetFor = ({ model, upstream }: ServeCandidate): ChatProtocol | undefined =>
    preference.find(target => model.endpoints[target] !== undefined && providerSupportsOperation(upstream.kind, target));
  const targets: Record<string, ChatTarget> = Object.fromEntries([[protocol, egress], ...translations]);
  if (Object.keys(targets).length !== preference.length) throw new TypeError(`Duplicate ${protocol} body target`);

  const declaration = preserveChatFacts(protocol);
  const into: Readonly<Record<string, typeof declaration>> = Object.fromEntries(
    preference.map(target => [target, declaration]),
  );
  const ending = defineStage({
    name: `${protocol}.route-body`,
    request: { needs: declaration.request.needs },
    into,
    async execute(facts, scope) {
      const { model, upstream } = facts['serve.candidate'];
      const target = targetFor(facts['serve.candidate']);
      if (target === undefined) throw new TypeError(`The ${protocol} body cannot serve ${upstream.id}/${model.id}`);
      return await scope.into[target]!(facts);
    },
  });

  return { ending, targets, serves: (candidate: ServeCandidate): boolean => targetFor(candidate) !== undefined };
};
