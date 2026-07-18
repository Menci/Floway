// The Agent Setup HTTP surface, built as dependency-injected Hono route
// factories so the package carries all domain logic while a host application
// supplies persistence and authentication. Two disjoint surfaces:
//
// - Public GET/HEAD script routes reveal the selected API key as executable
//   source to an unauthenticated machine. A host mounts them structurally ahead
//   of its logger / CORS / auth middleware, so no per-path bypass is needed;
//   every failure is sealed here so a thrown secret never escapes.
// - Authenticated control routes (POST / PUT / heartbeat) drive the lease
//   lifecycle. A host mounts them behind its auth middleware and injects the
//   authenticated user id.
//
// A lease token is the primary key: a user may hold many concurrent leases (one
// per open dashboard page), and a page's writes only ever touch its own token.

import { zValidator } from '@hono/zod-validator';
import { type Context, type Env, Hono } from 'hono';

import {
  type AgentSetupConfiguration,
  agentSetupConfigurationSchema,
  AgentSetupNoSelectableKeyError,
  defaultAgentSetupConfiguration,
} from './configuration.ts';
import { renderPowerShellPrefix, renderShellPrefix } from './render.ts';
import { type AgentSetupRecord, type AgentSetupRepository, AgentSetupTokenCollisionError } from './repository.ts';
import { SETUP_SCRIPT_BODIES } from './script-assets.ts';
import { generateAgentSetupToken } from './token.ts';
import { agentSetupHeartbeatBody, agentSetupUpdateBody } from './wire.ts';

const SETUP_LEASE_TTL_MS = 5 * 60 * 1000;

// Bounds the fresh-token retry so an unforeseen degenerate case cannot loop
// forever; a real collision is astronomically unlikely.
const SETUP_TOKEN_MAX_ATTEMPTS = 5;

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

// Retry an insert only when the token collides; every other error propagates.
const withFreshToken = async (insert: (token: string) => Promise<AgentSetupRecord>): Promise<AgentSetupRecord> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await insert(generateAgentSetupToken());
    } catch (error) {
      if (error instanceof AgentSetupTokenCollisionError && attempt < SETUP_TOKEN_MAX_ATTEMPTS) continue;
      throw error;
    }
  }
};

const leaseProjection = (record: AgentSetupRecord, publicScriptBasePath: string) => ({
  token: record.token,
  configuration: agentSetupConfigurationSchema.parse(JSON.parse(record.configurationJson)),
  configurationRevision: record.configurationRevision,
  expiresAt: record.expiresAt,
  scripts: {
    claude: {
      sh: `${publicScriptBasePath}/${record.token}/claude.sh`,
      ps1: `${publicScriptBasePath}/${record.token}/claude.ps1`,
    },
    codex: {
      sh: `${publicScriptBasePath}/${record.token}/codex.sh`,
      ps1: `${publicScriptBasePath}/${record.token}/codex.ps1`,
    },
  },
});

// A saved configuration is restored on reopen only while its key stays
// selectable; otherwise the caller falls back to a first-use default.
const restorableConfiguration = (
  record: AgentSetupRecord,
  selectableKeyIds: readonly string[],
): AgentSetupConfiguration | null => {
  const configuration = agentSetupConfigurationSchema.parse(JSON.parse(record.configurationJson));
  return selectableKeyIds.includes(configuration.apiKeyId) ? configuration : null;
};

// --- public script routes ---

export interface AgentSetupPublicDeps {
  repository: Pick<AgentSetupRepository, 'findByToken'>;
  // Confirm the lease owner still exists.
  userExists: (userId: number) => Promise<boolean>;
  // Resolve the servable API key label and secret for the lease owner, or null
  // when the key is gone or no longer owned by that user.
  resolveApiKey: (userId: number, apiKeyId: string) => Promise<{ name: string; secret: string } | null>;
}

// Every failure — unknown token, expired lease, deleted user or key, or a
// configuration pointing at a key the user no longer owns — collapses to null
// so the caller returns one indistinguishable 404.
const resolveServeableLease = async (
  deps: AgentSetupPublicDeps,
  token: string,
): Promise<{ apiKey: string; apiKeyName: string; configuration: AgentSetupConfiguration } | null> => {
  const record = await deps.repository.findByToken(token);
  if (!record || record.expiresAt <= Date.now()) return null;
  if (!(await deps.userExists(record.userId))) return null;
  const configuration = agentSetupConfigurationSchema.parse(JSON.parse(record.configurationJson));
  const apiKey = await deps.resolveApiKey(record.userId, configuration.apiKeyId);
  if (apiKey === null) return null;
  return { apiKey: apiKey.secret, apiKeyName: apiKey.name, configuration };
};

type ScriptLanguage = 'sh' | 'ps1';
type ScriptAgent = 'claude' | 'codex';

const publicErrorDiagnostics = (error: unknown, token: string): string => {
  if (!(error instanceof Error)) return `Thrown value type: ${typeof error}`;
  const frames = error.stack?.split('\n').slice(1).join('\n') ?? '(stack unavailable)';
  return `${error.name}\n${frames.replaceAll(token, '[setup-token]')}`;
};

export const createAgentSetupPublicRoutes = (deps: AgentSetupPublicDeps) => {
  const serveSetupScript = (agent: ScriptAgent, language: ScriptLanguage) => async (c: Context) => {
    const token = c.req.param('token')!;
    try {
      const resolved = await resolveServeableLease(deps, token);
      if (!resolved) return c.body(null, 404, SCRIPT_RESPONSE_HEADERS);
      // HEAD stops before rendering so it never assembles the API-key-bearing body.
      if (c.req.method === 'HEAD') return c.body(null, 200, SCRIPT_RESPONSE_HEADERS);

      const input = { agent, apiKey: resolved.apiKey, apiKeyName: resolved.apiKeyName, configuration: resolved.configuration };
      const prefix = language === 'sh' ? renderShellPrefix(input) : renderPowerShellPrefix(input);
      const body = prefix + SETUP_SCRIPT_BODIES[agent][language];
      return c.body(body, 200, SCRIPT_RESPONSE_HEADERS);
    } catch (error) {
      // Keep the unauthenticated response opaque. Operator diagnostics retain the
      // stack frames but omit the error message, which may contain a token or key.
      console.error('Agent Setup: failed to serve a public setup script', publicErrorDiagnostics(error, token));
      return c.json({ error: { type: 'internal_error' } }, 500);
    }
  };

  const notFound = (c: Context) => c.body(null, 404, SCRIPT_RESPONSE_HEADERS);

  return new Hono()
    .on(['GET', 'HEAD'], '/:token/claude.sh', serveSetupScript('claude', 'sh'))
    .on(['GET', 'HEAD'], '/:token/claude.ps1', serveSetupScript('claude', 'ps1'))
    .on(['GET', 'HEAD'], '/:token/codex.sh', serveSetupScript('codex', 'sh'))
    .on(['GET', 'HEAD'], '/:token/codex.ps1', serveSetupScript('codex', 'ps1'))
    // Consume every near-miss beneath a token-shaped path before the host's
    // middleware. A mistyped filename or HTTP method still carries the live
    // credential in its URL segment and must not fall through to access logs.
    .all('/:token{[A-Za-z0-9_-]{43}}', notFound)
    .all('/:token{[A-Za-z0-9_-]{43}}/*', notFound);
};

// --- authenticated control routes ---

export interface AgentSetupControlDeps<E extends Env> {
  repository: AgentSetupRepository;
  // Host-owned mount path for the public scripts, without a trailing slash.
  publicScriptBasePath: string;
  // Read the authenticated user id from the request context.
  getUserId: (c: Context<E>) => number;
  // The user's selectable API key ids (active, owned) in priority order.
  listSelectableApiKeyIds: (userId: number) => Promise<readonly string[]>;
}

export const createAgentSetupControlRoutes = <E extends Env>(deps: AgentSetupControlDeps<E>) => {
  // Hono narrows a validated route's handler context to an env that is
  // structurally E but not provably so inside this generic factory, so the
  // injected user id is read back through the declared env with one cast.
  const readUserId = (c: Context): number => deps.getUserId(c as Context<E>);

  return new Hono<E>()
    .post('/', async c => {
      const userId = readUserId(c);
      const selectableKeyIds = await deps.listSelectableApiKeyIds(userId);
      const latest = await deps.repository.latestByUserId(userId);
      const restored = latest !== null ? restorableConfiguration(latest, selectableKeyIds) : null;

      let configuration: AgentSetupConfiguration;
      if (restored !== null) {
        configuration = restored;
      } else {
        try {
          configuration = defaultAgentSetupConfiguration(selectableKeyIds);
        } catch (error) {
          if (error instanceof AgentSetupNoSelectableKeyError) return c.json({ status: 'no-selectable-key' as const }, 409);
          throw error;
        }
      }

      const now = Date.now();
      const record = await withFreshToken(token => deps.repository.insertForUser({
        userId,
        token,
        apiKeyId: configuration.apiKeyId,
        configurationJson: JSON.stringify(configuration),
        now,
        expiresAt: now + SETUP_LEASE_TTL_MS,
      }));
      return c.json({ status: 'ok' as const, ...leaseProjection(record, deps.publicScriptBasePath) });
    })
    .put('/', zValidator('json', agentSetupUpdateBody), async c => {
      const userId = readUserId(c);
      const { token, configuration, expectedRevision } = c.req.valid('json');

      const selectableKeyIds = await deps.listSelectableApiKeyIds(userId);
      if (!selectableKeyIds.includes(configuration.apiKeyId)) {
        return c.json({ error: 'The selected API key is not available on your account.' }, 400);
      }

      const now = Date.now();
      const result = await deps.repository.updateConfiguration({
        userId,
        token,
        expectedRevision,
        apiKeyId: configuration.apiKeyId,
        configurationJson: JSON.stringify(configuration),
        now,
        expiresAt: now + SETUP_LEASE_TTL_MS,
      });
      // 'ok' echoes the fresh lease; 'revision-conflict' rides the current lease
      // along under a 409 so the caller can rebase; 'missing' is terminal.
      if (result.status === 'ok') return c.json({ status: 'ok' as const, ...leaseProjection(result.record, deps.publicScriptBasePath) });
      if (result.status === 'revision-conflict') return c.json({ status: 'revision-conflict' as const, ...leaseProjection(result.record, deps.publicScriptBasePath) }, 409);
      return c.json({ status: 'missing' as const }, 409);
    })
    .post('/heartbeat', zValidator('json', agentSetupHeartbeatBody), async c => {
      const userId = readUserId(c);
      const { token } = c.req.valid('json');
      const result = await deps.repository.renewLease({
        userId,
        token,
        expiresAt: Date.now() + SETUP_LEASE_TTL_MS,
      });
      if (result.status === 'ok') return c.json({ status: 'ok' as const, ...leaseProjection(result.record, deps.publicScriptBasePath) });
      // Renewal never conflicts on a revision; a non-existent token is terminal.
      return c.json({ status: 'missing' as const }, 409);
    });
};
