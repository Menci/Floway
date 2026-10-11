export class InvalidAgentSetupEndpointError extends Error {}

export const normalizeAgentSetupEndpoint = (endpoint: string): string => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (cause) {
    throw new InvalidAgentSetupEndpointError('The endpoint must be an absolute URL', { cause });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new InvalidAgentSetupEndpointError('The endpoint must use HTTP or HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new InvalidAgentSetupEndpointError('The endpoint must contain only an origin and path');
  return url.toString().replace(/\/+$/, '');
};
