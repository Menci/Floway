import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { getOAuth2Config, oauth2FrontendRedirect, oauth2ProviderById, type OAuth2Config } from './oauth2-config.ts';
import { exchangeOAuth2Code, fetchOAuth2Identity, newOAuth2Secret, OAuth2ProtocolError, oauth2AuthorizationUrl } from './oauth2-protocol.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { generateApiKeyToken } from '../../shared/api-key-tokens.ts';
import { generateServerSecret } from '../../shared/server-secret.ts';
import type { oauth2RegisterBody, oauth2ResultBody } from '../schemas.ts';
import { loadKnownUpstreamIds } from '../shared/upstream-ids.ts';
import { userToSessionWire } from '../users/wire.ts';
import { sha256Hex, timingSafeEqual } from '@floway-dev/platform';

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();

const secretHash = (secret: string): Promise<string> => sha256Hex(encoder.encode(secret));
const secretMatchesHash = async (secret: string, expectedHash: string): Promise<boolean> =>
  timingSafeEqual(encoder.encode(await secretHash(secret)), encoder.encode(expectedHash));

const preventOAuth2Caching = (c: AuthedContext): void => {
  c.header('Cache-Control', 'no-store');
};

const transactionCookieName = (stateHash: string): string => `floway_oauth2_${stateHash.slice(0, 24)}`;

const transactionCookieOptions = (publicBaseUrl: string | null) => ({
  httpOnly: true,
  maxAge: AUTHORIZATION_TTL_MS / 1000,
  path: '/auth/oauth2',
  sameSite: 'Lax' as const,
  secure: publicBaseUrl?.startsWith('https:') ?? false,
});

const oauth2ErrorRedirect = (config: OAuth2Config, message: string): string => {
  return oauth2FrontendRedirect(config, new URLSearchParams({ oauth2_error: message.slice(0, 500) }));
};

const suggestedUsername = (providerLogin: string): string => {
  const normalized = providerLogin
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
  return normalized || 'user';
};

export const listOAuth2Providers = async (c: AuthedContext) => {
  preventOAuth2Caching(c);
  const providers = (await getOAuth2Config()).providers.map(provider => ({
    id: provider.id,
    displayName: provider.displayName,
  }));
  return c.json({ providers });
};

export const startOAuth2Login = async (c: AuthedContext<'/auth/oauth2/:provider/start'>) => {
  preventOAuth2Caching(c);
  const config = await getOAuth2Config();
  const provider = oauth2ProviderById(config, c.req.param('provider'));
  if (!provider) return c.json({ error: 'OAuth2 provider not found' }, 404);

  const state = newOAuth2Secret();
  const codeVerifier = newOAuth2Secret();
  const browserVerifier = newOAuth2Secret();
  const stateHash = await secretHash(state);
  await getRepo().oauth2.createAuthorization(stateHash, {
    providerId: provider.id,
    codeVerifier,
    browserVerifierHash: await secretHash(browserVerifier),
    expiresAt: Date.now() + AUTHORIZATION_TTL_MS,
  });
  setCookie(c, transactionCookieName(stateHash), browserVerifier, transactionCookieOptions(config.publicBaseUrl));
  return c.redirect(await oauth2AuthorizationUrl(config, provider, state, codeVerifier), 302);
};

export const finishOAuth2Callback = async (c: AuthedContext<'/auth/oauth2/:provider/callback'>) => {
  preventOAuth2Caching(c);
  const config = await getOAuth2Config();
  const provider = oauth2ProviderById(config, c.req.param('provider'));
  if (!provider) {
    if (config.publicBaseUrl === null) return c.json({ error: 'OAuth2 provider not found' }, 404);
    return c.redirect(oauth2ErrorRedirect(config, 'OAuth2 provider not found'), 302);
  }

  const state = c.req.query('state');
  if (!state) return c.redirect(oauth2ErrorRedirect(config, 'OAuth2 callback is missing state'), 302);
  const stateHash = await secretHash(state);
  const cookieName = transactionCookieName(stateHash);
  const browserVerifier = getCookie(c, cookieName);
  deleteCookie(c, cookieName, transactionCookieOptions(config.publicBaseUrl));
  const authorization = await getRepo().oauth2.takeAuthorization(stateHash, Date.now());
  if (!authorization || authorization.providerId !== provider.id) {
    return c.redirect(oauth2ErrorRedirect(config, 'OAuth2 state is invalid or expired'), 302);
  }
  if (!browserVerifier || !(await secretMatchesHash(browserVerifier, authorization.browserVerifierHash))) {
    return c.redirect(oauth2ErrorRedirect(config, 'OAuth2 login did not originate in this browser'), 302);
  }

  const providerError = c.req.query('error');
  if (providerError) {
    const description = c.req.query('error_description');
    return c.redirect(oauth2ErrorRedirect(config, description ?? providerError), 302);
  }
  const code = c.req.query('code');
  if (!code) return c.redirect(oauth2ErrorRedirect(config, 'OAuth2 callback is missing code'), 302);

  let identity;
  try {
    const accessToken = await exchangeOAuth2Code(config, provider, code, authorization.codeVerifier, c.req.raw.signal);
    identity = await fetchOAuth2Identity(provider, accessToken, c.req.raw.signal);
  } catch (cause) {
    if (!(cause instanceof OAuth2ProtocolError)) throw cause;
    return c.redirect(oauth2ErrorRedirect(config, cause.message), 302);
  }

  const now = new Date().toISOString();
  const account = await getRepo().oauth2.findAccountAndTouch(
    provider.id,
    identity.providerUserId,
    identity.providerLogin,
    now,
  );
  let userId: number | null = null;
  if (account) {
    const user = await getRepo().users.getById(account.userId);
    if (user) userId = user.id;
    else await getRepo().oauth2.deleteByUserId(account.userId);
  }

  const handoff = newOAuth2Secret();
  await getRepo().oauth2.createHandoff({
    tokenHash: await secretHash(handoff),
    providerId: provider.id,
    providerUserId: identity.providerUserId,
    providerLogin: identity.providerLogin,
    userId,
    createdAt: now,
    expiresAt: Date.now() + HANDOFF_TTL_MS,
  });
  return c.redirect(oauth2FrontendRedirect(config, new URLSearchParams({ oauth2_result: handoff })), 302);
};

export const resolveOAuth2Result = async (c: CtxWithJson<typeof oauth2ResultBody>) => {
  preventOAuth2Caching(c);
  const rawToken = c.req.valid('json').token;
  const tokenHash = await secretHash(rawToken);
  const repo = getRepo();
  const handoff = await repo.oauth2.getHandoff(tokenHash, Date.now());
  if (!handoff) return c.json({ error: 'OAuth2 login result is invalid or expired' }, 400);

  if (handoff.userId === null) {
    const provider = oauth2ProviderById(await getOAuth2Config(), handoff.providerId);
    return c.json({
      status: 'registration_required' as const,
      registrationToken: rawToken,
      providerId: handoff.providerId,
      providerDisplayName: provider?.displayName ?? handoff.providerId,
      providerLogin: handoff.providerLogin,
      suggestedUsername: suggestedUsername(handoff.providerLogin),
    });
  }

  const session = await repo.oauth2.completeLogin(tokenHash, Date.now());
  if (!session) return c.json({ error: 'OAuth2 login result is invalid or expired' }, 400);
  const user = await repo.users.getById(session.userId);
  if (!user) throw new Error(`OAuth2 login completed for missing user ${session.userId}`);
  return c.json({
    status: 'authenticated' as const,
    token: session.id,
    user: userToSessionWire(user, await loadKnownUpstreamIds()),
  });
};

export const registerOAuth2User = async (c: CtxWithJson<typeof oauth2RegisterBody>) => {
  preventOAuth2Caching(c);
  const body = c.req.valid('json');
  const createdAt = new Date().toISOString();
  const result = await getRepo().oauth2.register({
    tokenHash: await secretHash(body.registrationToken),
    username: body.username,
    createdAt,
    now: Date.now(),
    defaultKey: {
      id: crypto.randomUUID(),
      name: 'Default',
      key: generateApiKeyToken(),
      serverSecret: generateServerSecret(),
      createdAt,
      upstreamIds: null,
      deletedAt: null,
      dumpRetentionSeconds: null,
      responsesRetentionSeconds: 0,
    },
  });
  if (result.status === 'missing') return c.json({ error: 'OAuth2 registration is invalid or expired' }, 400);
  if (result.status === 'username-taken') {
    return c.json({ error: 'That username is already taken (usernames are case-insensitive).', code: 'username_taken' as const }, 409);
  }
  if (result.status === 'account-taken') {
    return c.json({ error: 'This OAuth2 account is already registered. Sign in again.', code: 'oauth2_account_registered' as const }, 409);
  }
  return c.json({
    token: result.session.id,
    user: userToSessionWire(result.user, await loadKnownUpstreamIds()),
  }, 201);
};
