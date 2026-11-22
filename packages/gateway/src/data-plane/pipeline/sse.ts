import type { GatewayPipelineServices } from './services.ts';
import type { SseOutcome, SseProtocol } from '../shared/sse.ts';
import type { ManagedStream, StageEnv } from '@floway-dev/pipeline';

export type { SseOutcome, SseProtocol } from '../shared/sse.ts';
export { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, serializeSseFrame } from '../shared/sse.ts';

export interface EncodeManagedSseStreamOptions<T> {
  readonly protocol: SseProtocol<T>;
  readonly label?: string;
  readonly onSettle: (outcome: SseOutcome) => void | Promise<void>;
}

export const encodeManagedSseStream = <TFrame>(
  env: StageEnv<GatewayPipelineServices>,
  events: ManagedStream<TFrame>,
  options: EncodeManagedSseStreamOptions<TFrame>,
): ManagedStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let terminalOutcome: SseOutcome | undefined;
  let settled = false;

  const resolveTerminal = (): SseOutcome => terminalOutcome ??= env.egressState.error === undefined
    ? { type: 'cancelled' }
    : { type: 'egress-error', error: env.egressState.error };

  return env.wrapStream<TFrame, Uint8Array>(events, {
    label: options.label ?? 'downstream.sse.bytes',
    async *transform(source, signal) {
      try {
        for await (const frame of source) {
          const output = options.protocol.encode(frame);
          if (output.wire !== null) yield encoder.encode(output.wire);
          if (output.end === undefined) continue;
          if (output.end.type === 'premature-eof') {
            for (const chunk of options.protocol.failure(output.end.error)) yield encoder.encode(chunk);
            terminalOutcome = { type: 'premature-eof', error: output.end.error };
            return;
          }
          for (const chunk of output.end.trailer ?? []) yield encoder.encode(chunk);
          terminalOutcome = { type: output.end.type };
          return;
        }

        if (signal.aborted || env.egressState.error !== undefined) {
          terminalOutcome = env.egressState.error === undefined
            ? { type: 'cancelled' }
            : { type: 'egress-error', error: env.egressState.error };
          return;
        }

        const end = options.protocol.eof();
        if (end.type === 'premature-eof') {
          for (const chunk of options.protocol.failure(end.error)) yield encoder.encode(chunk);
          terminalOutcome = { type: 'premature-eof', error: end.error };
          return;
        }
        for (const chunk of end.trailer ?? []) yield encoder.encode(chunk);
        terminalOutcome = { type: end.type };
      } catch (error) {
        if (signal.aborted || env.egressState.error !== undefined) {
          terminalOutcome = env.egressState.error === undefined
            ? { type: 'cancelled' }
            : { type: 'egress-error', error: env.egressState.error };
          return;
        }
        for (const chunk of options.protocol.failure(error)) yield encoder.encode(chunk);
        terminalOutcome = { type: 'source-error', error };
      }
    },
    onClose: async () => {
      if (settled) return;
      settled = true;
      await options.onSettle(resolveTerminal());
    },
  });
};
