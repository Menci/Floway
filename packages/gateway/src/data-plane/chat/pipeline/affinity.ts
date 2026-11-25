import type { ChatProtocol, ChatRequestKey, ChatResponseKey } from './topology.ts';
import type { GatewayPipelineFacts } from '../../pipeline/facts.ts';
import type { AttemptPreparation } from '../../pipeline/failover.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { selectAffinityCandidates, type AffinityCodec, type AffinityRequestAnalysis } from '../shared/affinity/index.ts';

type AffinityServices = Pick<GatewayServices, 'affinityCodec'>;
type ChatPreparation<Protocol extends ChatProtocol> = AttemptPreparation<ChatRequestKey<Protocol>, ChatResponseKey<Protocol>, AffinityServices>;

export const prepareChatAffinity = <
  const Protocol extends ChatProtocol,
  Payload extends GatewayPipelineFacts[ChatRequestKey<NoInfer<Protocol>>],
>(
  protocol: Protocol,
  analyze: (payload: Payload, codec: AffinityCodec) => Promise<AffinityRequestAnalysis<Payload>>,
  unavailable: ChatPreparation<NoInfer<Protocol>>['unavailable'],
): ChatPreparation<Protocol> => ({
  requestKey: `request.${protocol}`,
  async prepare(candidates, payload, services) {
    const affinity = await analyze(payload as Payload, services.affinityCodec());
    const selection = selectAffinityCandidates(candidates, affinity);
    if ('kind' in selection) return { kind: 'unavailable', message: selection.message };

    return {
      kind: 'targets',
      targets: selection.candidates.map(candidate => ({ candidate, payload: selection.payloadFor(candidate) })),
    };
  },
  unavailable,
});
