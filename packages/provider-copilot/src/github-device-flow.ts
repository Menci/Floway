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
    return await oauth.processDeviceCodeResponse(GITHUB_AUTHORIZATION_SERVER, GITHUB_CLIENT, resp);
  } catch (error) {
    // RFC 8628 returns authorization_pending and slow_down as OAuth error
    // responses, including with HTTP 200 on GitHub. Keep those protocol
    // outcomes in the compatibility shape consumed by the control plane;
    // malformed and non-OAuth failures continue to throw.
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
