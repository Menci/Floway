import { isAbortError } from '@floway-dev/provider';
import { ProxyDialError } from '@floway-dev/proxy';

// Only rejections from the network call itself are eligible for upstream failover.
export class UpstreamTransportError extends Error {
  override readonly name = 'UpstreamTransportError';

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export const runUpstreamTransport = async (run: () => Promise<Response>): Promise<Response> => {
  try {
    return await run();
  } catch (error) {
    if (isAbortError(error) || error instanceof ProxyDialError) throw error;
    throw new UpstreamTransportError(error);
  }
};

export const isUpstreamTransportError = (error: unknown): error is Error =>
  error instanceof UpstreamTransportError
  || (error instanceof ProxyDialError && error.stage !== 'config')
  || (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(isUpstreamTransportError));
