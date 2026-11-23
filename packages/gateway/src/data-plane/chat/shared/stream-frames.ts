import { isTransportFailure, type TransportFailure } from '@floway-dev/http';
import type { ManagedStream, Scope } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProviderFrame } from '@floway-dev/provider';

export const wrapProtocolFrames = <In, Out, S>(
  stream: ManagedStream<ProviderFrame<In>>,
  scope: Pick<Scope<S>, 'wrapStream'>,
  label: string,
  transform: (frames: AsyncIterable<ProtocolFrame<In>>) => AsyncIterable<ProtocolFrame<Out>>,
): ManagedStream<ProviderFrame<Out>> => scope.wrapStream(stream, {
  label,
  async *transform(source) {
    let failure: TransportFailure | undefined;
    const interrupted = Symbol('upstream transport interrupted');
    const frames = async function* () {
      for await (const frame of source) {
        if (isTransportFailure(frame)) {
          failure = frame;
          throw interrupted;
        }
        yield frame;
      }
    };
    try {
      for await (const frame of transform(frames())) {
        if (failure !== undefined) break;
        yield frame;
      }
    } catch (error) {
      if (error !== interrupted) throw error;
    }
    if (failure !== undefined) yield failure;
  },
});
