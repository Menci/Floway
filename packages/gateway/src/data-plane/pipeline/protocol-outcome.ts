import type { GatewayPipelineFacts, ProtocolResponseKey } from './facts.ts';
import type { HttpStreamError } from '@floway-dev/http';
import type { ManagedStream, Result } from '@floway-dev/pipeline';
import type { ProtocolStreamError } from '@floway-dev/provider';

export const isHttpStreamError = (value: unknown): value is HttpStreamError =>
  typeof value === 'object' && value !== null && 'kind' in value && Object.hasOwn(value, 'cause')
  && (value.kind === 'transport' || value.kind === 'abort');

type EventOf<Outcome> = Outcome extends { readonly kind: 'stream'; readonly stream: ManagedStream<infer Event, unknown> } ? Event : never;
type ResultOf<Outcome> = Outcome extends { readonly kind: 'result'; readonly result: infer Result } ? Result : never;

export type ProtocolEvent<Key extends ProtocolResponseKey> = EventOf<GatewayPipelineFacts[Key]>;
export type ProtocolResult<Key extends ProtocolResponseKey> = ResultOf<GatewayPipelineFacts[Key]>;

export type StreamVerdict = 'complete' | 'failure';

export const observeStreamOutcome = <Event>(verdict?: (event: Event) => StreamVerdict | undefined) => {
  let outcome: StreamVerdict | 'cancelled' | undefined;
  return {
    observe(item: Result<Event, ProtocolStreamError>): void {
      if (item.ok) outcome = verdict?.(item.value) ?? outcome;
      else if (item.error.kind !== 'abort') outcome = 'failure';
      else outcome ??= 'cancelled';
    },
    finish(signal: AbortSignal): StreamVerdict | 'cancelled' {
      return outcome ?? (signal.aborted ? 'cancelled' : 'complete');
    },
  };
};
