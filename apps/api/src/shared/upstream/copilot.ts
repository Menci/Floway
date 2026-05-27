// Copilot upstream adapter — wraps the existing copilotFetch + token exchange
// behind the generic Upstream interface. Reuses shared/copilot.ts so the token
// cache (in-process + KV) stays shared across all callers.

import { copilotFetch, isCopilotTokenFetchError, type CopilotAccountType } from '../copilot.ts';
import type { EndpointKey, Upstream, UpstreamFetchOptions } from './types.ts';

export interface CopilotUpstream extends Upstream {
  fetch(endpoint: EndpointKey, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response>;
}

// Copilot mounts its API at the host root and uses an Anthropic-style
// `/v1/messages` for the Messages endpoint while keeping `/chat/completions`,
// `/responses`, `/embeddings`, `/images/*`, and `/models` un-prefixed. These
// paths are not admin-configurable: they reflect Copilot's own contract, not
// a deployment choice.
const COPILOT_PATHS: Record<EndpointKey, string> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
  embeddings: '/embeddings',
  images_generations: '/images/generations',
  images_edits: '/images/edits',
  models: '/models',
};

export const COPILOT_SUPPORTED_ENDPOINTS = ['/chat/completions', '/responses', '/v1/messages', '/embeddings'];

export const createCopilotUpstream = (id: string, name: string, githubToken: string, accountType: CopilotAccountType): CopilotUpstream => {
  return {
    id,
    name,
    kind: 'copilot',
    supportedEndpoints: COPILOT_SUPPORTED_ENDPOINTS,
    fetch: async (endpoint, init, options) => {
      try {
        return await copilotFetch(COPILOT_PATHS[endpoint], init, githubToken, accountType, options?.extraHeaders ? { headers: options.extraHeaders } : undefined);
      } catch (error) {
        if (!isCopilotTokenFetchError(error)) throw error;
        return new Response(error.body, {
          status: error.status,
          headers: new Headers(error.headers),
        });
      }
    },
  };
};
