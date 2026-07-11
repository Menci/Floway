// The Agent Setup lease routes: the authenticated control surface the dashboard
// drives (acquire / edit / heartbeat a lease) and the unauthenticated public
// endpoints a user's machine curls to fetch a ready-to-run setup script.
//
// The public GET/HEAD endpoints reveal the selected long-lived API key as
// executable source, so they are deliberately the only routes auth lets through
// without a credential — gated by the exact matcher in middleware/request-path,
// bounded to a five-minute lease, and never echoing the token into an error.
// The script body itself is the fixed, checked-in installer embedded at build
// time (script-assets.generated.ts); only the language-native assignment prefix
// is rendered per request.

import { Hono } from 'hono';

import {
  type AgentSetupConfiguration,
  agentSetupConfigurationSchema,
  AgentSetupNoSelectableKeyError,
  defaultAgentSetupConfiguration,
} from './configuration.ts';
import { renderPowerShellPrefix, renderShellPrefix } from './render.ts';
import { SETUP_PS1_BODY, SETUP_SH_BODY } from './script-assets.generated.ts';
import { type AuthedContext, type AuthVars, userFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson, zValidator } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { AgentSetupMutation, AgentSetupRecord, ApiKey } from '../../repo/types.ts';
import { agentSetupCreateBody, agentSetupHeartbeatBody, agentSetupUpdateBody } from '../schemas.ts';

// A lease lives five minutes past the server's current time; the dashboard's
// per-minute heartbeat keeps a visible page's lease renewed.
const SETUP_LEASE_TTL_MS = 5 * 60 * 1000;

// Retry ceiling for a token-uniqueness collision. A 43-char base64url token has
// 256 bits of entropy, so a collision is a practical impossibility — the bound
// exists only to keep an unforeseen degenerate case from looping forever, not
// because collisions are expected.
const SETUP_TOKEN_MAX_ATTEMPTS = 5;

// The SQLite/D1 message the unique token index raises. Matching it lets a token
// collision be retried with a fresh token while any unrelated DB failure still
// propagates untouched.
const TOKEN_COLLISION_MESSAGE = /UNIQUE constraint failed: agent_setup\.token/i;

const SCRIPT_RESPONSE_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  // The rendered script carries a live API key: it must never be cached by any
  // hop. cache-control:no-store covers HTTP/1.1; Pragma and Expires cover the
  // HTTP/1.0 proxies and clients that ignore Cache-Control.
  'cache-control': 'no-store',
  'pragma': 'no-cache',
  'expires': '0',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;

// 32 CSPRNG bytes as an unpadded base64url string — exactly 43 characters, the
// shape the public matcher accepts.
const generateSetupToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

// Run a lease write that consumes a freshly minted token, retrying only when the
// unique token index rejects the value. Every other error — including any other
// DB failure — surfaces immediately.
const withFreshToken = async <T>(write: (token: string) => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write(generateSetupToken());
    } catch (error) {
      const collided = error instanceof Error && TOKEN_COLLISION_MESSAGE.test(error.message);
      if (collided && attempt < SETUP_TOKEN_MAX_ATTEMPTS) continue;
      throw error;
    }
  }
};

// Origin-relative script URLs: the dashboard combines them with its own origin,
// and a Node deployment behind a TLS-terminating proxy never has to trust a
// forwarded host/proto to build them.
const scriptUrls = (token: string) => ({
  sh: `/api/setup/${token}/setup.sh`,
  ps1: `/api/setup/${token}/setup.ps1`,
});

// The shape the dashboard receives for a live lease: the token it heartbeats
// against, the persisted configuration, the CAS revision, the expiry, and the
// relative script URLs.
const leaseProjection = (record: AgentSetupRecord) => ({
  token: record.token,
  configuration: agentSetupConfigurationSchema.parse(JSON.parse(record.configurationJson)),
  configurationRevision: record.configurationRevision,
  expiresAt: record.expiresAt,
  scripts: scriptUrls(record.token),
});

// Validate a browser-supplied public origin: a bare `http:`/`https:` origin with
// no credentials, no path beyond `/`, no query, and no fragment. Returns the
// canonical origin to store, or null when the input is not a bare origin.
const normalizeHttpOrigin = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url.origin;
};

// A saved configuration is restored on reopen only while its key stays
// selectable; otherwise the caller falls back to a first-use default.
const restorableConfiguration = (
  record: AgentSetupRecord,
  selectableKeys: readonly ApiKey[],
): AgentSetupConfiguration | null => {
  const configuration = agentSetupConfigurationSchema.parse(JSON.parse(record.configurationJson));
  return selectableKeys.some(key => key.id === configuration.apiKeyId) ? configuration : null;
};

// Resolve a token to a serveable lease, applying every public-serving check.
// Any failure — unknown token, expired lease, deleted user, deleted key, or a
// configuration pointing at a key the lease's user no longer owns — collapses
// to null so the caller returns one indistinguishable 404.
const resolveServeableLease = async (
  token: string,
): Promise<{ record: AgentSetupRecord; apiKey: ApiKey; configuration: AgentSetupConfiguration } | null> => {
  const repo = getRepo();
  const record = await repo.agentSetup.findByToken(token);
  if (!record || record.expiresAt <= Date.now()) return null;
  const user = await repo.users.getById(record.userId);
  if (!user) return null;
  const configuration = agentSetupConfigurationSchema.parse(JSON.parse(record.configurationJson));
  const apiKey = await repo.apiKeys.getById(configuration.apiKeyId);
  if (!apiKey || apiKey.userId !== record.userId) return null;
  return { record, apiKey, configuration };
};

type ScriptLanguage = 'sh' | 'ps1';

const serveSetupScript = (language: ScriptLanguage) => async (c: AuthedContext) => {
  const token = c.req.param('token')!;
  const resolved = await resolveServeableLease(token);
  if (!resolved) return c.body(null, 404, SCRIPT_RESPONSE_HEADERS);
  // GET and HEAD run the identical lookup; HEAD stops here, before rendering, so
  // it never assembles the API-key-bearing body it would immediately drop.
  if (c.req.method === 'HEAD') return c.body(null, 200, SCRIPT_RESPONSE_HEADERS);

  const input = { apiKey: resolved.apiKey.key, publicBaseUrl: resolved.record.publicBaseUrl, configuration: resolved.configuration };
  const body = language === 'sh'
    ? renderShellPrefix(input) + SETUP_SH_BODY
    : renderPowerShellPrefix(input) + SETUP_PS1_BODY;
  return c.body(body, 200, SCRIPT_RESPONSE_HEADERS);
};

const createSetupLease = async (c: CtxWithJson<typeof agentSetupCreateBody>) => {
  const userId = userFromContext(c).id;
  const { publicBaseUrl } = c.req.valid('json');

  const origin = normalizeHttpOrigin(publicBaseUrl);
  if (origin === null) {
    return c.json({ error: 'publicBaseUrl must be a bare http(s) origin with no credentials, path, query, or fragment.' }, 400);
  }

  // listByUserId returns the user's active keys in creation order — exactly the
  // "selectable" set the default picker and the restore check both consult.
  const selectableKeys = await getRepo().apiKeys.listByUserId(userId);
  const existing = await getRepo().agentSetup.getByUserId(userId);
  const restored = existing !== null ? restorableConfiguration(existing, selectableKeys) : null;

  let configuration: AgentSetupConfiguration;
  if (restored !== null) {
    configuration = restored;
  } else {
    try {
      configuration = defaultAgentSetupConfiguration(selectableKeys);
    } catch (error) {
      if (error instanceof AgentSetupNoSelectableKeyError) return c.json({ status: 'no-selectable-key' as const }, 409);
      throw error;
    }
  }

  const now = Date.now();
  const record = await withFreshToken(token => getRepo().agentSetup.replaceForUser({
    userId,
    token,
    apiKeyId: configuration.apiKeyId,
    configurationJson: JSON.stringify(configuration),
    publicBaseUrl: origin,
    now,
    expiresAt: now + SETUP_LEASE_TTL_MS,
  }));
  return c.json({ status: 'ok' as const, ...leaseProjection(record) });
};

const respondToMutation = (c: AuthedContext, result: AgentSetupMutation) => {
  if (result.status === 'ok') return c.json({ status: 'ok' as const, ...leaseProjection(result.record) });
  if (result.status === 'revision-conflict') {
    return c.json({ status: 'revision-conflict' as const, ...leaseProjection(result.record) }, 409);
  }
  return c.json({ status: 'superseded' as const }, 409);
};

const updateSetupLease = async (c: CtxWithJson<typeof agentSetupUpdateBody>) => {
  const userId = userFromContext(c).id;
  const { token, configuration, expectedRevision } = c.req.valid('json');

  const selectableKeys = await getRepo().apiKeys.listByUserId(userId);
  if (!selectableKeys.some(key => key.id === configuration.apiKeyId)) {
    return c.json({ error: 'The selected API key is not available on your account.' }, 400);
  }

  const now = Date.now();
  const result = await withFreshToken(replacementToken => getRepo().agentSetup.updateConfiguration({
    userId,
    token,
    expectedRevision,
    apiKeyId: configuration.apiKeyId,
    configurationJson: JSON.stringify(configuration),
    now,
    replacementToken,
    replacementExpiresAt: now + SETUP_LEASE_TTL_MS,
  }));
  return respondToMutation(c, result);
};

const heartbeatSetupLease = async (c: CtxWithJson<typeof agentSetupHeartbeatBody>) => {
  const userId = userFromContext(c).id;
  const { token } = c.req.valid('json');

  const now = Date.now();
  const result = await withFreshToken(replacementToken => getRepo().agentSetup.renewLease({
    userId,
    token,
    now,
    expiresAt: now + SETUP_LEASE_TTL_MS,
    replacementToken,
  }));
  return respondToMutation(c, result);
};

// Chained so the control routes flow their request/response types into the RPC
// client. The public GET/HEAD script routes are registered on the same sub-app
// but carry no RPC contract — the dashboard reaches them by relative URL, and a
// user's machine by curl.
export const agentSetupRoutes = new Hono<{ Variables: AuthVars }>()
  .post('/', zValidator('json', agentSetupCreateBody), createSetupLease)
  .put('/', zValidator('json', agentSetupUpdateBody), updateSetupLease)
  .post('/heartbeat', zValidator('json', agentSetupHeartbeatBody), heartbeatSetupLease)
  .on(['GET', 'HEAD'], '/:token/setup.sh', serveSetupScript('sh'))
  .on(['GET', 'HEAD'], '/:token/setup.ps1', serveSetupScript('ps1'));
