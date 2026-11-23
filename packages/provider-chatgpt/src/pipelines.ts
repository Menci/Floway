import { ChatGPTAccessOnlyCredentialError, chatgptPlanObservation, ensureChatGPTAccessToken, invalidateChatGPTAccessToken, mintChatGPTAccessToken, type ChatGPTPlanObservation } from './access-token.ts';
import { isObject } from './auth/guards.ts';
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
import { uuidV7 } from './ids.ts';
import { chatgptPlanSupportsImages } from './models.ts';
import { hasChatGPTQuotaReading, parseChatGPTQuotaHeaders, putChatGPTQuota } from './quota.ts';
import { injectDefaultInstructions } from './responses-default-instructions.ts';
import { projectMovedChatGPTResponsesFields } from './responses-lite.ts';
import { restoreChatGPTResponsesOutput } from './responses-output.ts';
import { prepareChatGPTResponsesRequest, stringField, trimHeader, type ChatGPTRequestIdentity } from './responses-request.ts';
import { stripUnsupportedFields } from './responses-strip-unsupported-fields.ts';
import type { ChatGPTAccessTokenEntry, ChatGPTAccountCredential } from './state.ts';
import { Bytes, compose, defineStage, secret, snapshotError, transform, type Deferred, type ErrorSnapshot, type StageEnv } from '@floway-dev/pipeline';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import {
  encodeHttpRequest, httpTerminal, httpUrl, parseCompactionStage, parseSseStage, readHttpBody, serializeOpenAIImagesEditsJsonPayload,
  type HeaderEntry, type HttpRequestFacts, type HttpResponseFacts, type OpenAIImagesEditsRequest,
  type ProviderHttpOutput, type ProviderInput, type ProviderPipelines, type ProviderResponsesInput, type ProviderResponsesOutput, type ProviderServices,
} from '@floway-dev/provider';

export interface ChatGPTCallEffects {
  persistRefreshTokenRotation(newRefreshToken: string): Promise<void>;
  persistTerminalState(state: 'session_terminated' | 'refresh_failed', message: string): Promise<void>;
}

interface ChatGPTPipelineOptions extends ChatGPTCallEffects {
  readonly upstreamId: string;
  readonly fallbackPlanType?: string;
  readonly readAccount: () => Promise<ChatGPTAccountCredential>;
}

type Account = Pick<ChatGPTAccountCredential, 'chatgptAccountId' | 'openaiDeviceId' | 'state'> & {
  readonly renewable: boolean;
};
type AccountFacts = { readonly 'request.chatgpt.account': Account };
type PreparedResponsesFacts = { readonly 'request.chatgpt.responses': ReturnType<typeof prepareChatGPTResponsesRequest> };
type HttpInput = { readonly 'request.http': HttpRequestFacts };
type HttpOutput = { readonly 'response.http': HttpResponseFacts };
type Persistence = { readonly persisted: true } | { readonly persisted: false; readonly error: ErrorSnapshot };
type QuotaOutput = { readonly 'response.chatgpt.quota': Deferred<Persistence> | undefined };
type BackendOutput = ProviderHttpOutput & QuotaOutput;

const plainHeaders = (entries: readonly HeaderEntry[]): Headers =>
  new Headers(entries.map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : value.reveal()]));

const readAccountStage = (options: ChatGPTPipelineOptions) => defineStage<{}, AccountFacts, {}, {}, ProviderServices>({
  name: 'chatgpt.read-account',
  through: {
    request: { needs: [], consumes: [], provides: ['request.chatgpt.account'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  async execute(facts, next) {
    const { chatgptAccountId, openaiDeviceId, state, refresh_token } = await options.readAccount();
    return await next({ ...facts, 'request.chatgpt.account': { chatgptAccountId, openaiDeviceId, state, renewable: refresh_token !== null } });
  },
});

interface BackendRequest {
  readonly path: string;
  readonly headers: readonly HeaderEntry[];
  readonly body: Record<string, unknown>;
}

interface BackendOperation<Input> {
  readonly name: string;
  readonly needs: readonly (keyof Input & string)[];
  readonly images?: true;
  readonly prepare: (facts: Input) => BackendRequest;
}

const syntheticResponse = (status: number, type: string, message: string, timing: HttpResponseFacts['timing']): HttpResponseFacts => ({
  status,
  statusText: '',
  headers: [['content-type', 'application/json']],
  body: Bytes.fromUtf8(JSON.stringify({ error: { type, message } })),
  timing,
});

const unavailable = (message: string, timing: HttpResponseFacts['timing']) =>
  syntheticResponse(503, 'chatgpt_upstream_unavailable', message, timing);

const imageUnavailable = (timing: HttpResponseFacts['timing']) =>
  syntheticResponse(403, 'image_tools_unavailable', 'ChatGPT Free accounts do not provide Codex image tools.', timing);

const parseUpstreamError = (rawText: string): { code: string | null; message: string } => {
  const fallback = { code: null, message: rawText.slice(0, 256) };
  let document: unknown;
  try {
    document = JSON.parse(rawText);
  } catch {
    return fallback;
  }
  if (!isObject(document)) return fallback;
  const error = isObject(document.error) ? document.error : {};
  return {
    code: typeof error.code === 'string' ? error.code : null,
    message: typeof error.message === 'string' ? error.message : typeof document.detail === 'string' ? document.detail : fallback.message,
  };
};

const mergeRetryPlan = (entry: ChatGPTAccessTokenEntry, fallback: ChatGPTPlanObservation | null): ChatGPTAccessTokenEntry => {
  if (entry.planType !== undefined || fallback === null) return entry;
  return {
    ...entry,
    planType: fallback.planType,
    ...(fallback.observedAt === undefined ? {} : { planObservedAt: fallback.observedAt }),
  };
};

const quotaObservation = (
  response: HttpResponseFacts,
  options: ChatGPTPipelineOptions,
  account: Account,
  images: boolean,
  env: StageEnv<ProviderServices>,
): Deferred<Persistence> | undefined => {
  const isRateLimited = response.status === 429;
  if (!isRateLimited && (response.status < 200 || response.status >= 300)) return undefined;
  const snapshot = parseChatGPTQuotaHeaders(plainHeaders(response.headers), { now: new Date(), isRateLimited });
  if (images && !hasChatGPTQuotaReading(snapshot)) return undefined;
  return env.defer<Persistence>('chatgpt.quota', putChatGPTQuota(options.upstreamId, account.chatgptAccountId, snapshot).then(
    () => ({ persisted: true }),
    cause => {
      const error = snapshotError(cause);
      env.log.warn('chatgpt_quota_persist_failed', { upstreamId: options.upstreamId, error });
      return { persisted: false, error };
    },
  ));
};

const backendStage = <Input extends AccountFacts & Pick<ProviderResponsesInput, 'provider.model'>>(
  options: ChatGPTPipelineOptions,
  operation: BackendOperation<Input>,
) => defineStage<Input, HttpInput, HttpOutput, BackendOutput, ProviderServices>({
  name: operation.name,
  through: {
    request: { needs: ['request.chatgpt.account', 'provider.model', ...operation.needs], consumes: [], provides: ['request.http'] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.modelKey', 'response.chatgpt.quota'] },
  },
  return: { provides: ['response.http', 'response.modelKey', 'response.chatgpt.quota'] },
  async execute(facts, next, env) {
    const account = facts['request.chatgpt.account'];
    const modelKey = facts['provider.model'].id;
    const now = env.clock();
    const timing = { startedAt: now, headersAt: now };
    const images = operation.images === true;
    const result = (response: HttpResponseFacts, back?: HttpOutput): BackendOutput => ({
      ...back,
      'response.http': response,
      'response.modelKey': modelKey,
      'response.chatgpt.quota': quotaObservation(response, options, account, images, env),
    });
    const refreshFailed = async (error: ChatGPTOAuthSessionTerminatedError, timed: HttpResponseFacts['timing']) => {
      await options.persistTerminalState('refresh_failed', error.upstreamMessage);
      return unavailable(`ChatGPT refresh failed: ${error.upstreamMessage}`, timed);
    };
    if (account.state !== 'active') return result(unavailable(`ChatGPT upstream is ${account.state}`, timing));

    const mint = (refreshToken: string) =>
      mintChatGPTAccessToken(refreshToken, env.services.fetcher(options.upstreamId), options.persistRefreshTokenRotation);
    let access: ChatGPTAccessTokenEntry;
    try {
      access = await ensureChatGPTAccessToken(options.upstreamId, account.chatgptAccountId, mint);
    } catch (error) {
      if (error instanceof ChatGPTOAuthSessionTerminatedError) return result(await refreshFailed(error, timing));
      if (error instanceof ChatGPTAccessOnlyCredentialError) return result(unavailable(error.message, timing));
      throw error;
    }

    const plan = chatgptPlanObservation(access);
    const imagePlan = plan ?? { planType: options.fallbackPlanType ?? '' };
    if (images && !chatgptPlanSupportsImages(imagePlan.planType)) return result(imageUnavailable(timing));
    const prepared = operation.prepare(facts);
    const headers = [...prepared.headers];
    if (account.chatgptAccountId !== null) headers.push(['chatgpt-account-id', account.chatgptAccountId]);
    const request = encodeHttpRequest({
      method: 'POST',
      url: httpUrl(`${CHATGPT_BACKEND_BASE}${prepared.path}`),
      headers,
      body: { kind: 'json', value: prepared.body },
    });
    const dispatch = (token: string) => next({
      ...facts,
      'request.http': { ...request, headers: [...request.headers, ['authorization', secret(`Bearer ${token}`)]] },
    });
    const terminalSession = async (message: string, timed: HttpResponseFacts['timing']) => {
      await options.persistTerminalState('session_terminated', message);
      return unavailable(`ChatGPT session terminated: ${message}`, timed);
    };
    const first = await dispatch(access.token);
    const firstResponse = first['response.http'];
    if (firstResponse.status !== 401) return result(firstResponse, first);
    const firstBody = await readHttpBody(firstResponse.body);
    const { code, message } = parseUpstreamError(firstBody.utf8());
    if (!account.renewable) {
      try {
        await options.persistTerminalState('session_terminated', message);
      } catch {
        // The rejected bearer response remains authoritative for access-only accounts.
      }
      return result({ ...firstResponse, body: firstBody }, first);
    }
    if (code === 'token_invalidated') return result(await terminalSession(message, firstResponse.timing), first);

    let refreshed: ChatGPTAccessTokenEntry;
    try {
      const retained = await invalidateChatGPTAccessToken(options.upstreamId, account.chatgptAccountId, access.token);
      refreshed = retained ?? await ensureChatGPTAccessToken(
        options.upstreamId,
        account.chatgptAccountId,
        async refreshToken => mergeRetryPlan(await mint(refreshToken), images ? imagePlan : plan),
        true,
      );
    } catch (error) {
      if (error instanceof ChatGPTOAuthSessionTerminatedError) return result(await refreshFailed(error, firstResponse.timing), first);
      throw error;
    }
    if (images && !chatgptPlanSupportsImages((chatgptPlanObservation(refreshed) ?? imagePlan).planType)) {
      return result(imageUnavailable(firstResponse.timing), first);
    }

    const second = await dispatch(refreshed.token);
    const secondResponse = second['response.http'];
    if (secondResponse.status !== 401) return result(secondResponse, second);
    const secondBody = await readHttpBody(secondResponse.body);
    const finalError = parseUpstreamError(secondBody.utf8());
    return finalError.code === 'token_invalidated'
      ? result(await terminalSession(finalError.message, secondResponse.timing), second)
      : result({ ...secondResponse, body: secondBody }, second);
  },
});

const codexHeaders = (accept: string, originator = CHATGPT_ORIGINATOR): HeaderEntry[] => [
  ['originator', originator],
  ['user-agent', CHATGPT_USER_AGENT],
  ['version', CHATGPT_CLI_VERSION],
  ['accept', accept],
  ['content-type', 'application/json'],
];

const turnHeaders = (identity: Pick<ChatGPTRequestIdentity, 'sessionId' | 'threadId' | 'clientRequestId' | 'windowId'>, metadata: string | null): HeaderEntry[] => {
  const headers: HeaderEntry[] = [
    ['session-id', identity.sessionId],
    ['thread-id', identity.threadId],
    ['x-client-request-id', identity.clientRequestId],
    ['x-codex-window-id', identity.windowId],
  ];
  if (metadata !== null) headers.push(['x-codex-turn-metadata', metadata]);
  return headers;
};

const prepareResponses = defineStage<ProviderResponsesInput & AccountFacts, PreparedResponsesFacts, ProviderResponsesOutput, ProviderResponsesOutput, ProviderServices>({
  name: 'chatgpt.responses.prepare',
  through: {
    request: {
      needs: ['provider.model', 'request.headers', 'request.payload', 'request.action', 'request.chatgpt.account'],
      consumes: [],
      provides: ['request.chatgpt.responses'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => ({
      ...facts,
      'request.chatgpt.responses': prepareChatGPTResponsesRequest({
        model: facts['provider.model'],
        deviceId: facts['request.chatgpt.account'].openaiDeviceId,
        headers: plainHeaders(facts['request.headers']),
        body: facts['request.payload'],
      }, facts['request.action']),
    }),
  })),
});

const normalizeResponsesMediaType = defineStage<ProviderResponsesInput, ProviderResponsesInput, HttpOutput, HttpOutput, ProviderServices>({
  name: 'chatgpt.responses.normalize-media-type',
  through: {
    request: { needs: ['request.action'], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http'] },
  },
  async execute(facts, next) {
    const back = await next(facts);
    const response = back['response.http'];
    if (facts['request.action'] === 'compact' || response.status < 200 || response.status >= 300) return back;
    if (isEventStreamMediaType(plainHeaders(response.headers).get('content-type'))) return back;
    // Codex can send SSE without a media type. Its parser consumes the same body in either case.
    // https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/endpoint/responses.rs
    const headers: HeaderEntry[] = response.headers.filter(([name]) => name.toLowerCase() !== 'content-type');
    headers.push(['content-type', 'text/event-stream']);
    return { ...back, 'response.http': { ...response, headers } };
  },
});

const restoreResponses = defineStage<PreparedResponsesFacts, PreparedResponsesFacts, ProviderResponsesOutput, ProviderResponsesOutput, ProviderServices>({
  name: 'chatgpt.responses.restore-output',
  through: {
    request: { needs: ['request.chatgpt.responses'], consumes: [], provides: [] },
    response: { needs: ['response.events'], consumes: [], provides: ['response.events'] },
  },
  async execute(facts, next, env) {
    const back = await next(facts);
    const events = back['response.events'];
    if (events === undefined) return back;
    const { movedFields } = facts['request.chatgpt.responses'];
    const projected = Object.keys(movedFields).length === 0 ? events : env.wrapStream(events, {
      label: 'chatgpt.responses.project-moved-fields',
      transform: source => projectMovedChatGPTResponsesFields(source, movedFields),
    });
    return {
      ...back,
      'response.events': env.wrapStream(projected, {
        label: 'chatgpt.responses.restore-output',
        transform: source => restoreChatGPTResponsesOutput(source),
      }),
    };
  },
});

const responsesPipeline = (options: ChatGPTPipelineOptions) => compose<ProviderResponsesInput, ProviderResponsesOutput & QuotaOutput, ProviderServices>('chatgpt.responses', {
  stages: [
    injectDefaultInstructions,
    stripUnsupportedFields,
    readAccountStage(options),
    prepareResponses,
    restoreResponses,
    parseCompactionStage(),
    parseSseStage('parseResponses', parseOpenAIResponsesStream, {
      needs: ['request.action'],
      when: (facts: ProviderResponsesInput) => facts['request.action'] === 'generate',
    }),
    normalizeResponsesMediaType,
    backendStage<ProviderResponsesInput & AccountFacts & PreparedResponsesFacts>(options, {
      name: 'chatgpt.responses.authenticate-and-dispatch',
      needs: ['request.action', 'request.chatgpt.responses'],
      prepare: facts => {
        const prepared = facts['request.chatgpt.responses'];
        const compact = facts['request.action'] === 'compact';
        const headers = [
          ...codexHeaders(compact ? 'application/json' : 'text/event-stream'),
          ...turnHeaders(prepared.identity, prepared.turnMetadataJson.header),
        ];
        if (prepared.responsesLite) headers.push([CHATGPT_RESPONSES_LITE_HEADER, 'true']);
        return {
          path: compact ? CHATGPT_OPENAI_RESPONSES_COMPACT_PATH : CHATGPT_OPENAI_RESPONSES_PATH,
          headers,
          body: prepared.body,
        };
      },
    }),
  ],
  ending: httpTerminal(options.upstreamId),
});

const unaryPipeline = <Payload>(
  options: ChatGPTPipelineOptions,
  operation: BackendOperation<ProviderInput<Payload> & AccountFacts>,
) => compose<ProviderInput<Payload>, BackendOutput, ProviderServices>(operation.name, {
  stages: [readAccountStage(options), backendStage(options, operation)],
  ending: httpTerminal(options.upstreamId),
});

const imagePipeline = <Payload>(
  options: ChatGPTPipelineOptions,
  name: string,
  path: string,
  buildBody: (body: Payload, modelKey: string) => Record<string, unknown>,
) => unaryPipeline<Payload>(options, {
  name,
  needs: ['request.headers', 'request.payload'],
  images: true,
  prepare: facts => {
    const headers = plainHeaders(facts['request.headers']);
    return {
      path,
      headers: [
        ...codexHeaders('application/json', trimHeader(headers, 'originator') ?? CHATGPT_ORIGINATOR),
        ['x-codex-image-turn-id', trimHeader(headers, 'x-codex-image-turn-id') ?? uuidV7()],
      ],
      body: buildBody(facts['request.payload'], facts['provider.model'].id),
    };
  },
});

export const createChatGPTPipelines = (options: ChatGPTPipelineOptions) => ({
  openaiResponses: responsesPipeline(options),
  openaiImagesGenerations: imagePipeline<Omit<OpenAIImagesGenerationsPayload, 'model'>>(
    options, 'chatgpt.images-generations', CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH, (body, model) => ({ ...body, model }),
  ),
  openaiImagesEdits: imagePipeline<OpenAIImagesEditsRequest>(
    options, 'chatgpt.images-edits', CHATGPT_OPENAI_IMAGES_EDITS_PATH, serializeOpenAIImagesEditsJsonPayload,
  ),
  alphaSearch: unaryPipeline<Record<string, unknown>>(options, {
    name: 'chatgpt.alpha-search',
    needs: ['request.headers', 'request.payload'],
    prepare: facts => {
      const body = facts['request.payload'];
      const id = stringField(body, 'id') ?? uuidV7();
      const metadata = trimHeader(plainHeaders(facts['request.headers']), 'x-codex-turn-metadata');
      return {
        path: CHATGPT_ALPHA_SEARCH_PATH,
        headers: [
          ...codexHeaders('application/json'),
          ...turnHeaders({ sessionId: id, threadId: id, clientRequestId: id, windowId: `${id}:0` }, metadata),
        ],
        body: { ...body, id, model: facts['provider.model'].id },
      };
    },
  }),
}) satisfies ProviderPipelines;
