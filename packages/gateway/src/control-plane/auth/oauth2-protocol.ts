import { oauth2CallbackUrl, type OAuth2Config, type OAuth2ProviderConfig } from './oauth2-config.ts';
export { OAuth2ProtocolError } from './oauth2-protocol-error.ts';
import { OAuth2ProtocolError } from './oauth2-protocol-error.ts';
import { getFetch } from '@floway-dev/platform';

const textEncoder = new TextEncoder();

const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64Url = (bytes: Uint8Array): string =>
  base64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const formEncode = (value: string): string => new URLSearchParams({ value }).toString().slice('value='.length);

export const newOAuth2Secret = (): string => base64Url(crypto.getRandomValues(new Uint8Array(32)));

// RFC 7636 S256 binds the authorization response to the browser-initiated
// transaction even if an authorization code is intercepted.
// https://www.rfc-editor.org/rfc/rfc7636#section-4.2
export const oauth2CodeChallenge = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(verifier));
  return base64Url(new Uint8Array(digest));
};

export const oauth2AuthorizationUrl = async (
  config: OAuth2Config,
  provider: OAuth2ProviderConfig,
  state: string,
  codeVerifier: string,
): Promise<string> => {
  const url = new URL(provider.authorizationEndpoint);
  for (const [key, value] of Object.entries(provider.authorizationParams)) url.searchParams.set(key, value);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', oauth2CallbackUrl(config, provider));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await oauth2CodeChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (provider.scopes.length > 0) url.searchParams.set('scope', provider.scopes.join(' '));
  return url.toString();
};

const responseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new OAuth2ProtocolError('OAuth2 provider response exceeded 1 MiB');
  return text;
};

const parseTokenBody = (text: string, contentType: string | null): Record<string, unknown> => {
  if (contentType?.toLowerCase().includes('json') || text.trimStart().startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new OAuth2ProtocolError('OAuth2 token endpoint returned malformed JSON', { cause });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new OAuth2ProtocolError('OAuth2 token endpoint returned a non-object response');
    }
    return parsed as Record<string, unknown>;
  }
  return Object.fromEntries(new URLSearchParams(text));
};

const providerError = (body: Record<string, unknown>): string | null => {
  const error = typeof body.error === 'string' ? body.error : null;
  if (!error) return null;
  const description = typeof body.error_description === 'string' ? body.error_description : null;
  return description ? `${error}: ${description}` : error;
};

export const exchangeOAuth2Code = async (
  config: OAuth2Config,
  provider: OAuth2ProviderConfig,
  code: string,
  codeVerifier: string,
  signal: AbortSignal,
): Promise<string> => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: oauth2CallbackUrl(config, provider),
    client_id: provider.clientId,
    code_verifier: codeVerifier,
  });
  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  });
  if (provider.clientAuthentication === 'client_secret_post') {
    body.set('client_secret', provider.clientSecret);
  } else {
    body.delete('client_id');
    // RFC 6749 requires each credential component to use the form encoding
    // before the pair is joined and Base64 encoded for HTTP Basic auth.
    // https://www.rfc-editor.org/rfc/rfc6749#section-2.3.1
    const credentials = `${formEncode(provider.clientId)}:${formEncode(provider.clientSecret)}`;
    headers.set('authorization', `Basic ${base64(textEncoder.encode(credentials))}`);
  }

  const response = await getFetch()(provider.tokenEndpoint, { method: 'POST', headers, body, signal });
  const text = await responseText(response);
  const tokenBody = parseTokenBody(text, response.headers.get('content-type'));
  const error = providerError(tokenBody);
  if (!response.ok || error) {
    throw new OAuth2ProtocolError(`OAuth2 token exchange failed (${response.status})${error ? `: ${error}` : ''}`);
  }
  const accessToken = tokenBody.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new OAuth2ProtocolError('OAuth2 token response is missing access_token');
  }
  return accessToken;
};

const claimAtPath = (userinfo: Record<string, unknown>, path: string): unknown => {
  let value: unknown = userinfo;
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
};

const claimString = (userinfo: Record<string, unknown>, paths: readonly string[]): string | null => {
  for (const path of paths) {
    const value = claimAtPath(userinfo, path);
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
};

export interface OAuth2Identity {
  providerUserId: string;
  providerLogin: string;
}

export const fetchOAuth2Identity = async (
  provider: OAuth2ProviderConfig,
  accessToken: string,
  signal: AbortSignal,
): Promise<OAuth2Identity> => {
  const response = await getFetch()(provider.userInfoEndpoint, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    signal,
  });
  const text = await responseText(response);
  if (!response.ok) throw new OAuth2ProtocolError(`OAuth2 userinfo request failed (${response.status})`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new OAuth2ProtocolError('OAuth2 userinfo endpoint returned malformed JSON', { cause });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OAuth2ProtocolError('OAuth2 userinfo endpoint returned a non-object response');
  }
  const userinfo = value as Record<string, unknown>;
  const idClaims = provider.userIdClaim ? [provider.userIdClaim] : ['sub', 'id', 'user_id'];
  const providerUserId = claimString(userinfo, idClaims);
  if (!providerUserId) throw new OAuth2ProtocolError('OAuth2 userinfo response is missing a stable user ID');
  const usernameClaims = provider.usernameClaim
    ? [provider.usernameClaim]
    : ['preferred_username', 'login', 'username', 'name', 'email', 'sub', 'id'];
  const providerLogin = claimString(userinfo, usernameClaims) ?? providerUserId;
  if (providerUserId.length > 1024 || providerLogin.length > 1024) {
    throw new OAuth2ProtocolError('OAuth2 userinfo identity exceeded 1024 characters');
  }
  return { providerUserId, providerLogin };
};
