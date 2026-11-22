import { ChatGPTAccessOnlyCredentialError, chatgptPlanObservation, ensureChatGPTAccessToken, invalidateChatGPTAccessToken, mintChatGPTAccessToken, type ChatGPTPlanObservation } from './access-token.ts';
import { ChatGPTOAuthSessionTerminatedError } from './auth/oauth.ts';
import {
  CHATGPT_ALPHA_SEARCH_PATH,
  CHATGPT_BACKEND_BASE,
  CHATGPT_CLI_VERSION,
  CHATGPT_OPENAI_IMAGES_EDITS_PATH,
  CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH,
  CHATGPT_OPENAI_RESPONSES_COMPACT_PATH,
  CHATGPT_OPENAI_RESPONSES_PATH,
  CHATGPT_ORIGINATOR,
  CHATGPT_RESPONSES_LITE_HEADER,
  CHATGPT_USER_AGENT,
} from './constants.ts';
import { chatgptStateEffects, type ChatGPTStateEffects } from './effects.ts';
import { uuidV7 } from './ids.ts';
import { chatgptPlanSupportsImages } from './models.ts';
import { hasChatGPTQuotaReading, parseChatGPTQuotaHeaders, putChatGPTQuota } from './quota.ts';
import { stripChatGPTUnsupportedFields } from './responses-fields.ts';
import { defaultChatGPTInstructions } from './responses-instructions.ts';
import { projectMovedChatGPTResponsesFields, type ChatGPTResponsesLiteRequest } from './responses-lite.ts';
import { restoreChatGPTResponsesOutput } from './responses-output.ts';
import { prepareChatGPTResponsesRequest, stringField, trimHeader, type ChatGPTRequestIdentity } from './responses-request.ts';
import { assertChatGPTUpstreamState, findChatGPTAccountIndex, type ChatGPTAccessTokenEntry, type ChatGPTAccountCredential } from './state.ts';
import { defineStage, pipeline, secret } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline, Secret, StageEnv } from '@floway-dev/pipeline';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResultEx } from '@floway-dev/protocols/openai-responses';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import {
  buildImagesEditsJsonPayload,
  buildWireHttpUrl,
  bytesToManagedStream,
  getProviderRepo,
  headersFromEntries,
  httpTerminal,
  parseUpstreamSseOutcome,
  readManagedBytes,
  syntheticJsonOutcome,
  type HttpOutcome,
  type ImageEditsPipelineRequest,
  type ProviderModelFacts,
  type ProviderPipelineAlphaSearchInput,
  type ProviderPipelineOpenAIImagesEditsInput,
  type ProviderPipelineOpenAIImagesGenerationsInput,
  type ProviderPipelineOpenAIResponsesInput,
  type ProviderPipelineResponsesOutcome,
  type ProviderPipelineServices,
  type ProviderPipelines,
  type UpstreamHttpRequest,
} from '@floway-dev/provider';

export interface ChatGPTPipelineConfig {
  readonly upstreamId: string;
  readonly accountId: string | null;
  readonly fallbackPlanType: string | undefined;
  readonly stateEffects?: ChatGPTStateEffects;
}

type PipelineConfig = Required<ChatGPTPipelineConfig>;

type PipelineEnv = StageEnv<ProviderPipelineServices>;

interface ChatGPTTokenFacts {
  readonly token: Secret<string>;
  readonly expiresAt: number | null;
  readonly refreshedAt: string;
  readonly planType?: string;
  readonly planObservedAt?: string;
}

interface ChatGPTAccountFacts {
  readonly chatgptAccountId: string | null;
  readonly refresh_token: Secret<string> | null;
  readonly state: ChatGPTAccountCredential['state'];
  readonly state_message?: string;
  readonly state_updated_at: string;
  readonly openaiDeviceId: string;
}

interface AccountFacts {
  readonly 'chatgpt.account': ChatGPTAccountFacts;
}

interface AccessTokenFacts {
  readonly 'chatgpt.accessToken': ChatGPTTokenFacts;
  readonly 'chatgpt.plan': string;
}

interface AuthenticatedFacts extends AccountFacts, AccessTokenFacts {}

interface PreparedResponsesFacts {
  readonly 'chatgpt.identity': ChatGPTRequestIdentity;
  readonly 'chatgpt.turnMetadataJson': string | null;
  readonly 'chatgpt.responsesLite': boolean;
  readonly 'chatgpt.movedFields': ChatGPTResponsesLiteRequest['movedFields'];
  readonly 'chatgpt.wireBody': Record<string, unknown>;
}

interface HttpRequestFacts {
  readonly 'request.http': UpstreamHttpRequest;
  readonly 'provider.modelKey': string;
}

const tokenFacts = (entry: ChatGPTAccessTokenEntry): ChatGPTTokenFacts => ({ ...entry, token: secret(entry.token) });

const accountFacts = (account: ChatGPTAccountCredential): ChatGPTAccountFacts => ({
  chatgptAccountId: account.chatgptAccountId,
  refresh_token: account.refresh_token === null ? null : secret(account.refresh_token),
  state: account.state,
  ...(account.state_message === undefined ? {} : { state_message: account.state_message }),
  state_updated_at: account.state_updated_at,
  openaiDeviceId: account.openaiDeviceId,
});

const accessTokenEntry = (facts: ChatGPTTokenFacts): ChatGPTAccessTokenEntry => ({
  token: facts.token.reveal(),
  expiresAt: facts.expiresAt,
  refreshedAt: facts.refreshedAt,
  ...(facts.planType === undefined ? {} : { planType: facts.planType }),
  ...(facts.planObservedAt === undefined ? {} : { planObservedAt: facts.planObservedAt }),
});

const unavailable = (env: PipelineEnv, state: string, modelKey?: string): HttpOutcome => syntheticJsonOutcome(env, {
  status: 503,
  body: { error: { type: 'chatgpt_upstream_unavailable', message: `ChatGPT upstream is ${state}` } },
  ...(modelKey === undefined ? {} : { modelKey }),
});

const imageUnavailable = (env: PipelineEnv, modelKey: string): HttpOutcome => syntheticJsonOutcome(env, {
  status: 403,
  body: { error: { type: 'image_tools_unavailable', message: 'ChatGPT Free accounts do not provide Codex image tools.' } },
  modelKey,
});

const syntheticFailure = (env: PipelineEnv, message: string, modelKey?: string): HttpOutcome => syntheticJsonOutcome(env, {
  status: 503,
  body: { error: { type: 'chatgpt_upstream_unavailable', message } },
  ...(modelKey === undefined ? {} : { modelKey }),
});

const refreshFailed = async (config: PipelineConfig, env: PipelineEnv, error: ChatGPTOAuthSessionTerminatedError, modelKey?: string): Promise<HttpOutcome> => {
  await config.stateEffects.persistTerminalState('refresh_failed', error.upstreamMessage);
  return syntheticFailure(env, `ChatGPT refresh failed: ${error.upstreamMessage}`, modelKey);
};
const readAccount = async (config: ChatGPTPipelineConfig): Promise<ChatGPTAccountCredential> => {
  const fresh = await getProviderRepo().upstreams.getById(config.upstreamId);
  if (!fresh) throw new Error(`ChatGPT upstream ${config.upstreamId} disappeared mid-request`);
  assertChatGPTUpstreamState(fresh.state);
  const index = findChatGPTAccountIndex(fresh.state, config.accountId);
  if (index < 0) throw new Error(`ChatGPT upstream ${config.upstreamId} state has no credential for account ${config.accountId}`);
  return fresh.state.accounts[index]!;
};

const ensureToken = async (
  config: PipelineConfig,
  env: PipelineEnv,
  account: Pick<ChatGPTAccountCredential, 'chatgptAccountId'>,
  force = false,
): Promise<{ readonly ok: true; readonly entry: ChatGPTAccessTokenEntry } | { readonly ok: false; readonly http: HttpOutcome }> => {
  try {
    return {
      ok: true,
      entry: await ensureChatGPTAccessToken(config.upstreamId, account.chatgptAccountId, refreshToken =>
        mintChatGPTAccessToken(refreshToken, env.fetcherFor(config.upstreamId), config.stateEffects.persistRefreshTokenRotation), force),
    };
  } catch (error) {
    if (error instanceof ChatGPTOAuthSessionTerminatedError) return { ok: false, http: await refreshFailed(config, env, error) };
    if (error instanceof ChatGPTAccessOnlyCredentialError) return { ok: false, http: syntheticFailure(env, error.message) };
    throw error;
  }
};

const refreshForRetry = async (
  config: PipelineConfig,
  env: PipelineEnv,
  account: ChatGPTAccountFacts,
  failed: ChatGPTAccessTokenEntry,
  fallbackPlan: ChatGPTPlanObservation | undefined = chatgptPlanObservation(failed) ?? undefined,
): Promise<{ readonly ok: true; readonly entry: ChatGPTAccessTokenEntry } | { readonly ok: false; readonly http: HttpOutcome }> => {
  const retained = await invalidateChatGPTAccessToken(config.upstreamId, account.chatgptAccountId, failed.token);
  if (retained !== null) return { ok: true, entry: retained };
  try {
    return {
      ok: true,
      entry: await ensureChatGPTAccessToken(config.upstreamId, account.chatgptAccountId, async refreshToken => {
        const minted = await mintChatGPTAccessToken(refreshToken, env.fetcherFor(config.upstreamId), config.stateEffects.persistRefreshTokenRotation);
        return mergeRetryPlan(minted, fallbackPlan);
      }, true),
    };
  } catch (error) {
    if (error instanceof ChatGPTOAuthSessionTerminatedError) return { ok: false, http: await refreshFailed(config, env, error) };
    throw error;
  }
};

const mergeRetryPlan = (entry: ChatGPTAccessTokenEntry, fallback: ChatGPTPlanObservation | undefined): ChatGPTAccessTokenEntry => {
  if (entry.planType !== undefined || fallback === undefined) return entry;
  return {
    ...entry,
    planType: fallback.planType,
    ...(fallback.observedAt === undefined ? {} : { planObservedAt: fallback.observedAt }),
  };
};

const planFor = (entry: ChatGPTAccessTokenEntry, fallback: string | undefined): string => entry.planType ?? fallback ?? '';

const codexHeaders = (
  account: ChatGPTAccountFacts,
  token: Secret<string>,
  accept: string,
): readonly HeaderEntry[] => [
  ['authorization', secret(`Bearer ${token.reveal()}`)],
  ...(account.chatgptAccountId === null ? [] : [['chatgpt-account-id', account.chatgptAccountId] as const]),
  ['originator', CHATGPT_ORIGINATOR],
  ['user-agent', CHATGPT_USER_AGENT],
  ['version', CHATGPT_CLI_VERSION],
  ['accept', accept],
  ['content-type', 'application/json'],
];

const imageHeaders = (
  inbound: readonly HeaderEntry[],
  account: ChatGPTAccountFacts,
  token: Secret<string>,
  turnId: string,
): readonly HeaderEntry[] => [
  ['authorization', secret(`Bearer ${token.reveal()}`)],
  ...(account.chatgptAccountId === null ? [] : [['chatgpt-account-id', account.chatgptAccountId] as const]),
  ['originator', trimHeader(new Headers(inbound.map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : value.reveal()])), 'originator') ?? CHATGPT_ORIGINATOR],
  ['user-agent', CHATGPT_USER_AGENT],
  ['version', CHATGPT_CLI_VERSION],
  ['accept', 'application/json'],
  ['content-type', 'application/json'],
  ['x-codex-image-turn-id', turnId],
];

const quotaPolicy = (operation: 'alphaSearch' | 'openaiResponses' | 'openaiImagesGenerations' | 'openaiImagesEdits'): 'always' | 'when-present' =>
  operation === 'openaiImagesGenerations' || operation === 'openaiImagesEdits' ? 'when-present' : 'always';

const observeQuota = (
  config: ChatGPTPipelineConfig,
  env: PipelineEnv,
  account: ChatGPTAccountFacts,
  operation: Parameters<typeof quotaPolicy>[0],
  http: HttpOutcome,
): void => {
  if ((http.status < 200 || http.status >= 300) && http.status !== 429) return;
  const snapshot = parseChatGPTQuotaHeaders(headersFromEntries(http.headers), { now: new Date(), isRateLimited: http.status === 429 });
  if (quotaPolicy(operation) === 'when-present' && !hasChatGPTQuotaReading(snapshot)) return;
  env.waitUntil(putChatGPTQuota(config.upstreamId, account.chatgptAccountId, snapshot).catch(() => {}));
};

const parseUnauthorized = (bytes: Uint8Array): { readonly code: string | null; readonly message: string } => {
  const raw = new TextDecoder().decode(bytes);
  try {
    const root = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown }; detail?: unknown };
    const code = root.error !== null && typeof root.error === 'object' && typeof root.error.code === 'string' ? root.error.code : null;
    const message = root.error !== null && typeof root.error === 'object' && typeof root.error.message === 'string'
      ? root.error.message
      : typeof root.detail === 'string' ? root.detail : raw.slice(0, 256);
    return { code, message };
  } catch {
    return { code: null, message: raw.slice(0, 256) };
  }
};

const ensureSse = (http: HttpOutcome): HttpOutcome => {
  if (isEventStreamMediaType(headersFromEntries(http.headers).get('content-type') ?? '')) return http;
  return {
    ...http,
    headers: [
      ...http.headers.filter(([name]) => name.toLowerCase() !== 'content-type'),
      ['content-type', 'text/event-stream'],
    ],
  };
};

const retryUnauthorized = async <Facts extends AuthenticatedFacts & { readonly 'provider.model': ProviderModelFacts }, Out>(options: {
  readonly config: PipelineConfig;
  readonly env: PipelineEnv;
  readonly facts: Readonly<Facts>;
  readonly first: HttpOutcome;
  readonly retry: (entry: ChatGPTAccessTokenEntry) => Promise<HttpOutcome>;
  readonly classify: (http: HttpOutcome, entry: ChatGPTAccessTokenEntry) => Promise<Out>;
  readonly fallbackPlan?: ChatGPTPlanObservation;
}): Promise<Out> => {
  const { config, env, facts, first, retry, classify, fallbackPlan } = options;
  const bytes = await readManagedBytes(first.body);
  const parsed = parseUnauthorized(bytes);
  const account = facts['chatgpt.account'];
  if (account.refresh_token === null) {
    await config.stateEffects.persistTerminalState('session_terminated', parsed.message).catch(() => {});
    return await classify({ ...first, body: bytesToManagedStream(bytes, env) }, accessTokenEntry(facts['chatgpt.accessToken']));
  }
  if (parsed.code === 'token_invalidated') {
    await config.stateEffects.persistTerminalState('session_terminated', parsed.message);
    return await classify(syntheticFailure(env, `ChatGPT session terminated: ${parsed.message}`, facts['provider.model'].id), accessTokenEntry(facts['chatgpt.accessToken']));
  }
  const refreshed = await refreshForRetry(config, env, account, accessTokenEntry(facts['chatgpt.accessToken']), fallbackPlan);
  if (!refreshed.ok) return await classify(refreshed.http, accessTokenEntry(facts['chatgpt.accessToken']));
  const second = await retry(refreshed.entry);
  if (second.status !== 401) return await classify(second, refreshed.entry);
  const secondBytes = await readManagedBytes(second.body);
  const secondParsed = parseUnauthorized(secondBytes);
  if (secondParsed.code === 'token_invalidated') {
    await config.stateEffects.persistTerminalState('session_terminated', secondParsed.message);
    return await classify(syntheticFailure(env, `ChatGPT session terminated: ${secondParsed.message}`, facts['provider.model'].id), refreshed.entry);
  }
  return await classify({ ...second, body: bytesToManagedStream(secondBytes, env) }, refreshed.entry);
};

const genericReadAccount = <Input extends { readonly 'provider.model': ProviderModelFacts }, Out>(config: Required<ChatGPTPipelineConfig>) => defineStage<
  Input,
  AccountFacts,
  Out,
  Out,
  never,
  ProviderPipelineServices
>({
  name: 'chatgpt.read-account',
  provides: ['chatgpt.account'],
  execute: async (_facts, next) => await next({
    'chatgpt.account': accountFacts(await readAccount(config)),
  }),
});

const genericAuthenticate = <Input extends AccountFacts & { readonly 'provider.model': ProviderModelFacts }, Out>(
  config: Required<ChatGPTPipelineConfig>,
  failure: (http: HttpOutcome) => Out,
) => defineStage<
  Input,
  AccessTokenFacts,
  Out,
  Out,
  never,
  ProviderPipelineServices
>({
  name: 'chatgpt.authenticate',
  provides: ['chatgpt.accessToken', 'chatgpt.plan'],
  execute: async (facts, next, env) => {
    const account = facts['chatgpt.account'];
    const modelKey = facts['provider.model'].id;
    if (account.state !== 'active') return failure(unavailable(env, account.state, modelKey));
    const ready = await ensureToken(config, env, account);
    if (!ready.ok) return failure(ready.http);
    return await next({
      'chatgpt.accessToken': tokenFacts(ready.entry),
      'chatgpt.plan': planFor(ready.entry, config.fallbackPlanType),
    });
  },
});

const imageTurnId = (headers: readonly HeaderEntry[]): string => {
  const plain = new Headers(headers.map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : value.reveal()]));
  return trimHeader(plain, 'x-codex-image-turn-id') ?? uuidV7();
};

const imagesGenerationsPipeline = (config: Required<ChatGPTPipelineConfig>): Pipeline<ProviderPipelineOpenAIImagesGenerationsInput, HttpOutcome, ProviderPipelineServices> => {
  const stage = defineStage<
    ProviderPipelineOpenAIImagesGenerationsInput & AuthenticatedFacts,
    HttpRequestFacts,
    HttpOutcome,
    HttpOutcome,
    never,
    ProviderPipelineServices
  >({
    name: 'chatgpt.openai-images-generations',
    provides: ['request.http', 'provider.modelKey'],
    execute: async (facts, next, env) => {
      if (!chatgptPlanSupportsImages(facts['chatgpt.plan'])) return imageUnavailable(env, facts['provider.model'].id);
      const turnId = imageTurnId(facts['request.inboundHeaders']);
      const build = (token: Secret<string>): HttpRequestFacts => ({
        'request.http': {
          method: 'POST',
          url: buildWireHttpUrl(CHATGPT_BACKEND_BASE, CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH),
          headers: imageHeaders(facts['request.inboundHeaders'], facts['chatgpt.account'], token, turnId),
          body: { kind: 'json', value: { ...facts['request.payload'], model: facts['provider.model'].id } },
        },
        'provider.modelKey': facts['provider.model'].id,
      });
      const first = await next(build(facts['chatgpt.accessToken'].token));
      if (first.status !== 401) {
        observeQuota(config, env, facts['chatgpt.account'], 'openaiImagesGenerations', first);
        return first;
      }
      return await retryUnauthorized({
        config,
        env,
        facts,
        first,
        retry: async entry => {
          if (!chatgptPlanSupportsImages(entry.planType ?? facts['chatgpt.plan'])) return imageUnavailable(env, facts['provider.model'].id);
          const second = await next(build(tokenFacts(entry).token));
          if (second.status !== 401) observeQuota(config, env, facts['chatgpt.account'], 'openaiImagesGenerations', second);
          return second;
        },
        classify: async http => http,
        fallbackPlan: { planType: facts['chatgpt.plan'] },
      });
    },
  });
  return pipeline<ProviderPipelineOpenAIImagesGenerationsInput>('chatgpt.openai-images-generations')
    .use(genericReadAccount<ProviderPipelineOpenAIImagesGenerationsInput, HttpOutcome>(config))
    .use(genericAuthenticate(config, http => http))
    .use(stage)
    .end(httpTerminal(config.upstreamId));
};
const imagesEditsPipeline = (config: Required<ChatGPTPipelineConfig>): Pipeline<ProviderPipelineOpenAIImagesEditsInput, HttpOutcome, ProviderPipelineServices> => {
  const stage = defineStage<
    ProviderPipelineOpenAIImagesEditsInput & AuthenticatedFacts,
    HttpRequestFacts,
    HttpOutcome,
    HttpOutcome,
    never,
    ProviderPipelineServices
  >({
    name: 'chatgpt.openai-images-edits',
    provides: ['request.http', 'provider.modelKey'],
    execute: async (facts, next, env) => {
      if (!chatgptPlanSupportsImages(facts['chatgpt.plan'])) return imageUnavailable(env, facts['provider.model'].id);
      const turnId = imageTurnId(facts['request.inboundHeaders']);
      const body = buildImagesEditsJsonPayload(facts['request.payload'] as ImageEditsPipelineRequest, facts['provider.model'].id);
      const build = (token: Secret<string>): HttpRequestFacts => ({
        'request.http': {
          method: 'POST',
          url: buildWireHttpUrl(CHATGPT_BACKEND_BASE, CHATGPT_OPENAI_IMAGES_EDITS_PATH),
          headers: imageHeaders(facts['request.inboundHeaders'], facts['chatgpt.account'], token, turnId),
          body: { kind: 'json', value: body },
        },
        'provider.modelKey': facts['provider.model'].id,
      });
      const first = await next(build(facts['chatgpt.accessToken'].token));
      if (first.status !== 401) {
        observeQuota(config, env, facts['chatgpt.account'], 'openaiImagesEdits', first);
        return first;
      }
      return await retryUnauthorized({
        config,
        env,
        facts,
        first,
        retry: async entry => {
          if (!chatgptPlanSupportsImages(entry.planType ?? facts['chatgpt.plan'])) return imageUnavailable(env, facts['provider.model'].id);
          const second = await next(build(tokenFacts(entry).token));
          if (second.status !== 401) observeQuota(config, env, facts['chatgpt.account'], 'openaiImagesEdits', second);
          return second;
        },
        classify: async http => http,
        fallbackPlan: { planType: facts['chatgpt.plan'] },
      });
    },
  });
  return pipeline<ProviderPipelineOpenAIImagesEditsInput>('chatgpt.openai-images-edits')
    .use(genericReadAccount<ProviderPipelineOpenAIImagesEditsInput, HttpOutcome>(config))
    .use(genericAuthenticate(config, http => http))
    .use(stage)
    .end(httpTerminal(config.upstreamId));
};

export const createChatGPTPipelines = (config: ChatGPTPipelineConfig): ProviderPipelines => {
  const resolved = { ...config, stateEffects: config.stateEffects ?? chatgptStateEffects(config.upstreamId, config.accountId) };
  return {
    alphaSearch: alphaSearchPipeline(resolved),
    openaiResponses: responsesPipeline(resolved),
    openaiImagesGenerations: imagesGenerationsPipeline(resolved),
    openaiImagesEdits: imagesEditsPipeline(resolved),
  };
};

const alphaSearchPipeline = (config: Required<ChatGPTPipelineConfig>): Pipeline<ProviderPipelineAlphaSearchInput, HttpOutcome, ProviderPipelineServices> => {
  const stage = defineStage<
    ProviderPipelineAlphaSearchInput & AccountFacts & AuthenticatedFacts,
    HttpRequestFacts,
    HttpOutcome,
    HttpOutcome,
    never,
    ProviderPipelineServices
  >({
    name: 'chatgpt.alpha-search',
    provides: ['request.http', 'provider.modelKey'],
    execute: async (facts, next, env) => {
      const id = stringField(facts['request.payload'], 'id') ?? uuidV7();
      const plainInbound = new Headers(facts['request.inboundHeaders'].map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : value.reveal()]));
      const identity: ChatGPTRequestIdentity = {
        installationId: facts['chatgpt.account'].openaiDeviceId,
        sessionId: id,
        threadId: id,
        clientRequestId: id,
        turnId: uuidV7(),
        windowId: `${id}:0`,
      };
      const turnMetadata = trimHeader(plainInbound, 'x-codex-turn-metadata');
      const build = (token: Secret<string>): HttpRequestFacts => ({
        'request.http': {
          method: 'POST',
          url: buildWireHttpUrl(CHATGPT_BACKEND_BASE, CHATGPT_ALPHA_SEARCH_PATH),
          headers: [
            ...codexHeaders(facts['chatgpt.account'], token, 'application/json'),
            ['session-id', identity.sessionId],
            ['thread-id', identity.threadId],
            ['x-client-request-id', identity.clientRequestId],
            ['x-codex-window-id', identity.windowId],
            ...(turnMetadata === null ? [] : [['x-codex-turn-metadata', turnMetadata] as const]),
          ],
          body: { kind: 'json', value: { ...facts['request.payload'], id, model: facts['provider.model'].id } },
        },
        'provider.modelKey': facts['provider.model'].id,
      });
      const first = await next(build(facts['chatgpt.accessToken'].token));
      if (first.status !== 401) {
        observeQuota(config, env, facts['chatgpt.account'], 'alphaSearch', first);
        return first;
      }
      return await retryUnauthorized({
        config,
        env,
        facts,
        first,
        retry: async entry => {
          const second = await next(build(tokenFacts(entry).token));
          if (second.status !== 401) observeQuota(config, env, facts['chatgpt.account'], 'alphaSearch', second);
          return second;
        },
        classify: async http => http,
      });
    },
  });
  return pipeline<ProviderPipelineAlphaSearchInput>('chatgpt.alpha-search')
    .use(genericReadAccount<ProviderPipelineAlphaSearchInput, HttpOutcome>(config))
    .use(genericAuthenticate(config, http => http))
    .use(stage)
    .end(httpTerminal(config.upstreamId));
};
const responsesPipeline = (config: Required<ChatGPTPipelineConfig>): Pipeline<ProviderPipelineOpenAIResponsesInput, ProviderPipelineResponsesOutcome, ProviderPipelineServices> => {
  const inject = defineStage<ProviderPipelineOpenAIResponsesInput, { readonly 'request.payload': Omit<CanonicalOpenAIResponsesPayload, 'model'> }, ProviderPipelineResponsesOutcome, ProviderPipelineResponsesOutcome, 'request.payload', ProviderPipelineServices>({
    name: 'chatgpt.openai-responses.inject-default-instructions',
    consumes: ['request.payload'],
    provides: ['request.payload'],
    execute: async (facts, next) => await next({ 'request.payload': defaultChatGPTInstructions(facts['request.payload'], facts['provider.model']) }),
  });
  const strip = defineStage<ProviderPipelineOpenAIResponsesInput, { readonly 'request.payload': Omit<CanonicalOpenAIResponsesPayload, 'model'> }, ProviderPipelineResponsesOutcome, ProviderPipelineResponsesOutcome, 'request.payload', ProviderPipelineServices>({
    name: 'chatgpt.openai-responses.strip-unsupported-fields',
    consumes: ['request.payload'],
    provides: ['request.payload'],
    execute: async (facts, next) => await next({ 'request.payload': stripChatGPTUnsupportedFields(facts['request.payload']) }),
  });
  const prepare = defineStage<ProviderPipelineOpenAIResponsesInput & AccountFacts, PreparedResponsesFacts, ProviderPipelineResponsesOutcome, ProviderPipelineResponsesOutcome, never, ProviderPipelineServices>({
    name: 'chatgpt.openai-responses.prepare',
    provides: ['chatgpt.identity', 'chatgpt.turnMetadataJson', 'chatgpt.responsesLite', 'chatgpt.movedFields', 'chatgpt.wireBody'],
    execute: async (facts, next) => {
      const prepared = prepareChatGPTResponsesRequest({
        account: facts['chatgpt.account'],
        model: facts['provider.model'],
        body: facts['request.payload'],
        headers: new Headers(facts['request.inboundHeaders'].map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : value.reveal()])),
        action: facts['request.action'],
      });
      return await next({
        'chatgpt.identity': prepared.identity,
        'chatgpt.turnMetadataJson': prepared.turnMetadataJson.header.length === 0 ? null : prepared.turnMetadataJson.header,
        'chatgpt.responsesLite': prepared.responsesLite,
        'chatgpt.movedFields': prepared.movedFields,
        'chatgpt.wireBody': prepared.body,
      });
    },
  });
  const auth = defineStage<ProviderPipelineOpenAIResponsesInput & AccountFacts & PreparedResponsesFacts, AccessTokenFacts, ProviderPipelineResponsesOutcome, ProviderPipelineResponsesOutcome, never, ProviderPipelineServices>({
    name: 'chatgpt.openai-responses.authenticate',
    provides: ['chatgpt.accessToken', 'chatgpt.plan'],
    execute: async (facts, next, env) => {
      const account = facts['chatgpt.account'];
      if (account.state !== 'active') return { action: facts['request.action'], ok: false, modelKey: facts['provider.model'].id, http: unavailable(env, account.state, facts['provider.model'].id) };
      const ready = await ensureToken(config, env, account);
      if (!ready.ok) return { action: facts['request.action'], ok: false, modelKey: facts['provider.model'].id, http: ready.http };
      return await next({
        'chatgpt.accessToken': tokenFacts(ready.entry),
        'chatgpt.plan': planFor(ready.entry, config.fallbackPlanType),
      });
    },
  });
  const retry = defineStage<ProviderPipelineOpenAIResponsesInput & PreparedResponsesFacts & AuthenticatedFacts, HttpRequestFacts, HttpOutcome, ProviderPipelineResponsesOutcome, never, ProviderPipelineServices>({
    name: 'chatgpt.openai-responses.retry-access',
    provides: ['request.http', 'provider.modelKey'],
    execute: async (facts, next, env) => {
      const build = (token: Secret<string>): HttpRequestFacts => ({
        'request.http': {
          method: 'POST',
          url: buildWireHttpUrl(CHATGPT_BACKEND_BASE, facts['request.action'] === 'compact' ? CHATGPT_OPENAI_RESPONSES_COMPACT_PATH : CHATGPT_OPENAI_RESPONSES_PATH),
          headers: [
            ...codexHeaders(facts['chatgpt.account'], token, facts['request.action'] === 'compact' ? 'application/json' : 'text/event-stream'),
            ['session-id', facts['chatgpt.identity'].sessionId],
            ['thread-id', facts['chatgpt.identity'].threadId],
            ['x-client-request-id', facts['chatgpt.identity'].clientRequestId],
            ['x-codex-window-id', facts['chatgpt.identity'].windowId],
            ...(facts['chatgpt.turnMetadataJson'] === null ? [] : [['x-codex-turn-metadata', facts['chatgpt.turnMetadataJson']] as const]),
            ...(facts['chatgpt.responsesLite'] ? [[CHATGPT_RESPONSES_LITE_HEADER, 'true'] as const] : []),
          ],
          body: { kind: 'json', value: facts['chatgpt.wireBody'] },
        },
        'provider.modelKey': facts['provider.model'].id,
      });
      const classify = async (http: HttpOutcome, _entry: ChatGPTAccessTokenEntry): Promise<ProviderPipelineResponsesOutcome> => await classifyResponses(http, facts, env);
      const first = await next(build(facts['chatgpt.accessToken'].token));
      if (first.status !== 401) {
        observeQuota(config, env, facts['chatgpt.account'], 'openaiResponses', first);
        return await classify(first, accessTokenEntry(facts['chatgpt.accessToken']));
      }
      return await retryUnauthorized({
        config,
        env,
        facts,
        first,
        retry: async entry => {
          const second = await next(build(tokenFacts(entry).token));
          if (second.status !== 401) observeQuota(config, env, facts['chatgpt.account'], 'openaiResponses', second);
          return second;
        },
        classify,
      });
    },
  });
  return pipeline<ProviderPipelineOpenAIResponsesInput>('chatgpt.openai-responses')
    .use(inject)
    .use(strip)
    .use(genericReadAccount<ProviderPipelineOpenAIResponsesInput, ProviderPipelineResponsesOutcome>(config))
    .use(prepare)
    .use(auth)
    .use(retry)
    .end(httpTerminal(config.upstreamId));
};

const classifyResponses = async (
  http: HttpOutcome,
  facts: Readonly<ProviderPipelineOpenAIResponsesInput & PreparedResponsesFacts>,
  env: PipelineEnv,
): Promise<ProviderPipelineResponsesOutcome> => {
  const modelKey = facts['provider.model'].id;
  if (http.status < 200 || http.status >= 300) return { action: facts['request.action'], ok: false, modelKey, http };
  if (facts['request.action'] === 'compact') {
    const bytes = await readManagedBytes(http.body);
    const result = JSON.parse(new TextDecoder().decode(bytes)) as OpenAIResponsesCompactionResultEx;
    return { action: 'compact', ok: true, result, modelKey, http: { status: http.status, statusText: http.statusText, headers: http.headers, timing: http.timing } };
  }
  const parsed = await parseUpstreamSseOutcome(ensureSse(http), parseOpenAIResponsesStream, env);
  if (!parsed.ok) return { action: 'generate', ...parsed };
  let frames = parsed.events;
  if (Object.keys(facts['chatgpt.movedFields']).length > 0) {
    frames = env.wrapStream(frames, { label: 'chatgpt.responses.project', transform: source => projectMovedChatGPTResponsesFields(source, facts['chatgpt.movedFields']) });
  }
  frames = env.wrapStream(frames, { label: 'chatgpt.responses.restore-output', transform: source => restoreChatGPTResponsesOutput(source) });
  return { action: 'generate', ...parsed, events: frames };
};
