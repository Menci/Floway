import { UpstreamTransportError } from '@floway-dev/http';
import { isAbortError } from '@floway-dev/provider';
import { ProxyDialError } from '@floway-dev/proxy';

export { isUpstreamTransportError, UPSTREAM_TRANSPORT_ERROR, UpstreamTransportError } from '@floway-dev/http';

export const runUpstreamTransport = async (run: () => Promise<Response>): Promise<Response> => {
  try {
    return await run();
  } catch (error) {
    if (isAbortError(error) || error instanceof ProxyDialError) throw error;
    throw new UpstreamTransportError(error);
  }
};
