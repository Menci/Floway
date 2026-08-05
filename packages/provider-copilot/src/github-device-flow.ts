import * as oauth from 'oauth4webapi';

import type { CopilotUpstreamUser } from './config.ts';
import { directFetcher, type Fetcher } from '@floway-dev/provider';

const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_SCOPES = 'read:user';
const GITHUB_AUTHORIZATION_SERVER = {
  issuer: 'https://github.com',
  device_authorization_endpoint: 'https://github.com/login/device/code',
  token_endpoint: 'https://github.com/login/oauth/access_token',
} satisfies oauth.AuthorizationServer;
const GITHUB_CLIENT = { client_id: GITHUB_CLIENT_ID } satisfies oauth.Client;
const GITHUB_CLIENT_AUTH = oauth.None();

interface GitHubDeviceFlowStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface GitHubDeviceFlowPoll {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
  [parameter: string]: unknown;
}

const oauthRequestOptions = (fetcher: Fetcher) => ({
  headers: { accept: 'application/json' },
  [oauth.customFetch]: (url: string, init: RequestInit) => fetcher(url, init),
});

const normalizeGitHubDeviceCodeErrorStatus = async (response: Response): Promise<Response> => {
  if (response.status !== 200) return response;

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return response;
  const error = Reflect.get(body, 'error');
  if (typeof error !== 'string' || error.length === 0) return response;

  // GitHub sends its documented device-flow errors with HTTP 200, while the
  // OAuth processor recognizes error bodies on 4xx responses. Normalize only
  // that transport quirk so the library still parses both errors and tokens.
  // https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#error-codes-for-the-device-flow
  return new Response(response.body, {
    status: 400,
    headers: response.headers,
  });
};

// All GitHub egress accepts a Fetcher so the copilot auth poll can forward
// the operator's edit-form proxy override; absent that, direct egress.
export const startGitHubDeviceFlow = async (fetcher: Fetcher = directFetcher) => {
  const resp = await oauth.deviceAuthorizationRequest(
    GITHUB_AUTHORIZATION_SERVER,
    GITHUB_CLIENT,
    GITHUB_CLIENT_AUTH,
    { scope: GITHUB_SCOPES },
    oauthRequestOptions(fetcher),
  );

  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false as const, error: `GitHub error: ${text}` };
  }

  const data = await oauth.processDeviceAuthorizationResponse(GITHUB_AUTHORIZATION_SERVER, GITHUB_CLIENT, resp);
  if (data.interval === undefined) throw new Error('GitHub device authorization response missing interval');
  return { ok: true as const, data: { ...data, interval: data.interval } satisfies GitHubDeviceFlowStart };
};

export const pollGitHubDeviceFlow = async (deviceCode: string, fetcher: Fetcher = directFetcher): Promise<GitHubDeviceFlowPoll> => {
  const resp = await oauth.deviceCodeGrantRequest(
    GITHUB_AUTHORIZATION_SERVER,
    GITHUB_CLIENT,
    GITHUB_CLIENT_AUTH,
    deviceCode,
    oauthRequestOptions(fetcher),
  );

  try {
    return await oauth.processDeviceCodeResponse(
      GITHUB_AUTHORIZATION_SERVER,
      GITHUB_CLIENT,
      await normalizeGitHubDeviceCodeErrorStatus(resp),
    );
  } catch (error) {
    if (error instanceof oauth.ResponseBodyError) return error.cause as GitHubDeviceFlowPoll;
    throw error;
  }
};

export const fetchGitHubUser = async (githubToken: string, fetcher: Fetcher = directFetcher) => {
  const userResp = await fetcher('https://api.github.com/user', {
    headers: {
      authorization: `token ${githubToken}`,
      accept: 'application/json',
      'user-agent': 'floway',
    },
  });

  if (!userResp.ok) throw new Error(`GitHub user lookup failed: ${userResp.status} ${await userResp.text()}`);
  return (await userResp.json()) as CopilotUpstreamUser;
};
