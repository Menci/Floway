import type { ChatProtocol, ChatResponseKey } from './topology.ts';
import { computeUsage, type UsageObserver } from '../../pipeline/compute-usage.ts';
import { enterProvider } from '../../pipeline/enter-provider.ts';
import type { gatewayFactSpace } from '../../pipeline/facts.ts';
import { recordPerformance } from '../../pipeline/performance.ts';
import type { ProtocolEvent, StreamVerdict } from '../../pipeline/protocol-outcome.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';

type Stages = Parameters<ReturnType<typeof gatewayFactSpace<GatewayServices>>['compose']>[1]['stages'];

export const chatEgress = <const Protocol extends ChatProtocol>(protocol: Protocol, {
  usage,
  firstOutput,
  verdict,
  normalizers = [],
}: {
  readonly usage: UsageObserver<ChatResponseKey<NoInfer<Protocol>>>;
  readonly firstOutput: (event: ProtocolEvent<ChatResponseKey<NoInfer<Protocol>>>) => boolean;
  readonly verdict: (event: ProtocolEvent<ChatResponseKey<NoInfer<Protocol>>>) => StreamVerdict | undefined;
  readonly normalizers?: Stages;
}) => {
  const responseKey: ChatResponseKey<Protocol> = `response.${protocol}`;
  return {
    stages: [
      storeUsage,
      recordPerformance(responseKey, 'chat', { firstOutput, verdict }),
      computeUsage(responseKey, usage, verdict),
      ...normalizers,
    ],
    ...enterProvider(protocol),
  };
};
