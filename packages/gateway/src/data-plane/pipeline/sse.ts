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

  const resolveTerminal = (): SseOutcome => {
    if (env.egressState.error !== undefined) return { type: 'egress-error', error: env.egressState.error };
    return terminalOutcome ?? { type: 'cancelled' };
  };

  return env.wrapStream<TFrame, Uint8Array>(events, {
    label: options.label ?? 'downstream.sse.bytes',
    async *transform(source, signal) {
      const emitTerminal = async function* (
        wire: string | null,
        trailer: readonly string[],
        outcome: SseOutcome,
      ): AsyncGenerator<Uint8Array> {
        const chunks = wire === null ? trailer : [wire, ...trailer];
        if (chunks.length === 0) {
          terminalOutcome = outcome;
          return;
        }
        for (const chunk of chunks.slice(0, -1)) yield encoder.encode(chunk);
        terminalOutcome = outcome;
        yield encoder.encode(chunks[chunks.length - 1]!);
      };

      try {
        for await (const frame of source) {
          const output = options.protocol.encode(frame);
          if (output.end === undefined) {
            if (output.wire !== null) yield encoder.encode(output.wire);
            continue;
          }
          if (output.end.type === 'premature-eof') {
            yield* emitTerminal(output.wire, options.protocol.failure(output.end.error), { type: 'premature-eof', error: output.end.error });
            return;
          }
          yield* emitTerminal(output.wire, output.end.trailer ?? [], { type: output.end.type });
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
          yield* emitTerminal(null, options.protocol.failure(end.error), { type: 'premature-eof', error: end.error });
          return;
        }
        yield* emitTerminal(null, end.trailer ?? [], { type: end.type });
      } catch (error) {
        if (signal.aborted || env.egressState.error !== undefined) {
          terminalOutcome = env.egressState.error === undefined
            ? { type: 'cancelled' }
            : { type: 'egress-error', error: env.egressState.error };
          return;
        }
        yield* emitTerminal(null, options.protocol.failure(error), { type: 'source-error', error });
      }
    },
    onClose: async () => {
      if (settled) return;
      settled = true;
      await options.onSettle(resolveTerminal());
    },
  });
};
