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

export const isNativeFetchTransportError = (error: unknown): boolean =>
  // https://github.com/nodejs/undici/blob/34151bf879d5aa1f6bd7a86870c6fcc0e1056c32/lib/web/fetch/index.js#L272
  // https://github.com/nodejs/undici/blob/34151bf879d5aa1f6bd7a86870c6fcc0e1056c32/lib/web/fetch/index.js#L2193
  (error instanceof TypeError && (error.message === 'fetch failed' || error.message === 'terminated'))
  // https://github.com/cloudflare/workerd/blob/29ee6949f48c3bd97b5bec542777f53ef42a3397/src/workerd/jsg/util.c%2B%2B#L322-L336
  || (error instanceof Error && error.message === 'Network connection lost.');
