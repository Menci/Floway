import { Agent, EnvHttpProxyAgent, Pool, type Dispatcher } from 'undici';

interface ProxyEnvironment {
  readonly http_proxy?: string;
  readonly HTTP_PROXY?: string;
  readonly https_proxy?: string;
  readonly HTTPS_PROXY?: string;
  readonly no_proxy?: string;
  readonly NO_PROXY?: string;
}

const isCopilotDataPlaneHost = (hostname: string): boolean =>
  hostname === 'githubcopilot.com' || hostname.endsWith('.githubcopilot.com');

// Copilot data-plane hosts close their keep-alive socket after each response;
// reusing it surfaces as UND_ERR_SOCKET or RequestContentLengthMismatchError.
// The token exchange owns the exact hostname, so the family match covers every
// GitHub account tier while `pipelining: 0` disables reuse for those pools.
// https://github.com/nodejs/undici/blob/v6.21.0/docs/docs/api/Client.md#parameter-clientoptions
// https://github.com/Menci/Floway/pull/78#issuecomment-4765475966
export const nodePoolOptions = (
  origin: string | URL,
  options: Pool.Options,
): Pool.Options => {
  const hostname = typeof origin === 'string' ? new URL(origin).hostname : origin.hostname;
  return isCopilotDataPlaneHost(hostname) ? { ...options, pipelining: 0 } : options;
};

type AgentFactory = NonNullable<Agent.Options['factory']>;

const createPool: AgentFactory = (origin, options): Dispatcher =>
  new Pool(origin, nodePoolOptions(origin, options as Pool.Options));

export const createNodeGlobalDispatcher = (
  env: ProxyEnvironment = process.env,
): Dispatcher => {
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY;
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY;
  const noProxy = env.no_proxy ?? env.NO_PROXY;
  const options = { factory: createPool };

  if (!httpProxy && !httpsProxy) return new Agent(options);
  return new EnvHttpProxyAgent({
    ...options,
    httpProxy: httpProxy ?? '',
    httpsProxy: httpsProxy ?? '',
    noProxy: noProxy ?? '',
  });
};
