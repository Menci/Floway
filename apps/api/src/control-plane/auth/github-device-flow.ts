import { githubHeaders, isCopilotAccountType, type CopilotAccountType } from '../../shared/copilot.ts';

export interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
  id: number;
}

const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_SCOPES = 'read:user';

interface GitHubDeviceFlowStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export const startGitHubDeviceFlow = async () => {
  const resp = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_SCOPES,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false as const, error: `GitHub error: ${text}` };
  }

  const data = (await resp.json()) as GitHubDeviceFlowStart;
  return { ok: true as const, data };
};

export const pollGitHubDeviceFlow = async (deviceCode: string) => {
  const resp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  return (await resp.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
    interval?: number;
  };
};

export const fetchGitHubUser = async (githubToken: string) => {
  const userResp = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `token ${githubToken}`,
      accept: 'application/json',
      'user-agent': 'floway',
    },
  });

  if (!userResp.ok) throw new Error(`GitHub user lookup failed: ${userResp.status} ${await userResp.text()}`);
  return (await userResp.json()) as GitHubUser;
};

export const detectAccountType = async (githubToken: string): Promise<CopilotAccountType> => {
  const resp = await fetch('https://api.github.com/copilot_internal/user', {
    headers: githubHeaders(githubToken),
  });
  if (!resp.ok) throw new Error(`GitHub Copilot account type detection failed: ${resp.status} ${await resp.text()}`);

  const data = (await resp.json()) as { copilot_plan?: unknown };
  if (!isCopilotAccountType(data.copilot_plan)) throw new Error(`Unknown GitHub Copilot plan: ${String(data.copilot_plan)}`);
  return data.copilot_plan;
};
