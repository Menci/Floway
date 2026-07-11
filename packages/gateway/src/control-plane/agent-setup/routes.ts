// The public GET/HEAD script endpoints reveal the selected API key as executable
// source, so they are the only routes auth lets through without a credential —
// gated by the exact matcher in middleware/request-path, bounded to a
// five-minute lease, and never echoing the token into an error.

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
import { agentSetupHeartbeatBody, agentSetupUpdateBody } from '../schemas.ts';

const SETUP_LEASE_TTL_MS = 5 * 60 * 1000;

// A 43-char base64url token carries 256 bits of entropy, so a collision is a
// practical impossibility; the bound only stops an unforeseen degenerate case
// from looping forever.
const SETUP_TOKEN_MAX_ATTEMPTS = 5;

// The unique token index's SQLite/D1 message. Matching it retries a collision
// with a fresh token while any unrelated DB failure still propagates untouched.
const TOKEN_COLLISION_MESSAGE = /UNIQUE constraint failed: agent_setup\.token/i;

const SCRIPT_RESPONSE_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  // The rendered script carries a live API key and must never be cached by any
  // hop: no-store covers HTTP/1.1, Pragma/Expires cover HTTP/1.0.
  'cache-control': 'no-store',
  'pragma': 'no-cache',
  'expires': '0',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;

// 32 CSPRNG bytes as unpadded base64url — exactly the 43-char shape the public
// matcher accepts.
const generateSetupToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

// Retry a lease write only when the unique token index rejects the token; every
// other error surfaces immediately.
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

const leaseProjection = (record: AgentSetupRecord) => ({
  token: record.token,
  configuration: agentSetupConfigurationSchema.parse(JSON.parse(record.configurationJson)),
  configurationRevision: record.configurationRevision,
  expiresAt: record.expiresAt,
  scripts: {
    sh: `/api/setup/${record.token}/setup.sh`,
    ps1: `/api/setup/${record.token}/setup.ps1`,
  },
});

// A saved configuration is restored on reopen only while its key stays
// selectable; otherwise the caller falls back to a first-use default.
const restorableConfiguration = (
  record: AgentSetupRecord,
  selectableKeys: readonly ApiKey[],
): AgentSetupConfiguration | null => {
  const configuration = agentSetupConfigurationSchema.parse(JSON.parse(record.configurationJson));
  return selectableKeys.some(key => key.id === configuration.apiKeyId) ? configuration : null;
};

// Every failure — unknown token, expired lease, deleted user or key, or a
// configuration pointing at a key the user no longer owns — collapses to null
// so the caller returns one indistinguishable 404.
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
  // HEAD stops before rendering so it never assembles the API-key-bearing body.
  if (c.req.method === 'HEAD') return c.body(null, 200, SCRIPT_RESPONSE_HEADERS);

  const input = { apiKey: resolved.apiKey.key, configuration: resolved.configuration };
  const body = language === 'sh'
    ? renderShellPrefix(input) + SETUP_SH_BODY
    : renderPowerShellPrefix(input) + SETUP_PS1_BODY;
  return c.body(body, 200, SCRIPT_RESPONSE_HEADERS);
};

const createSetupLease = async (c: AuthedContext) => {
  const userId = userFromContext(c).id;

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

// Chained so the control routes flow their types into the RPC client; the public
// GET/HEAD script routes carry no RPC contract.
export const agentSetupRoutes = new Hono<{ Variables: AuthVars }>()
  .post('/', createSetupLease)
  .put('/', zValidator('json', agentSetupUpdateBody), updateSetupLease)
  .post('/heartbeat', zValidator('json', agentSetupHeartbeatBody), heartbeatSetupLease)
  .on(['GET', 'HEAD'], '/:token/setup.sh', serveSetupScript('sh'))
  .on(['GET', 'HEAD'], '/:token/setup.ps1', serveSetupScript('ps1'));
