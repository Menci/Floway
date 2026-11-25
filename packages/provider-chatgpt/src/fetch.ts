import { ChatGPTAccessOnlyCredentialError, chatgptPlanObservation, invalidateChatGPTAccessToken, mintChatGPTAccessToken, type ChatGPTPlanObservation } from './access-token.ts';
import { ChatGPTOAuthSessionTerminatedError } from './auth/oauth.ts';
import {
  CHATGPT_BACKEND_BASE,
  CHATGPT_CLI_VERSION,
  CHATGPT_ALPHA_SEARCH_PATH,
  CHATGPT_OPENAI_IMAGES_EDITS_PATH,
  CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH,
  CHATGPT_ORIGINATOR,
  CHATGPT_OPENAI_RESPONSES_COMPACT_PATH,
  CHATGPT_OPENAI_RESPONSES_PATH,
  CHATGPT_RESPONSES_LITE_HEADER,
  CHATGPT_USER_AGENT,
} from './constants.ts';
import { uuidV7 } from './ids.ts';
import { chatgptPlanSupportsImages } from './models.ts';
import {
  hasChatGPTQuotaReading,
  parseChatGPTQuotaHeaders,
  putChatGPTQuota,
} from './quota.ts';
import { projectMovedChatGPTResponsesFields } from './responses-lite.ts';
import { restoreChatGPTResponsesOutput } from './responses-output.ts';
import { prepareChatGPTResponsesRequest, stringField, type ChatGPTRequestIdentity } from './responses-request.ts';
import { ensureChatGPTAccessToken } from './service.ts';
import type { ChatGPTAccessTokenEntry, ChatGPTAccountCredential } from './state.ts';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import { parseOpenAIResponsesStream, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesCompactionResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { jsonRequestBody, serializeOpenAIImagesEditsJsonPayload, type OpenAIImagesEditsRequest, type ProviderCallResult, type ProviderCompactionResult, type ProviderModel, type ProviderStreamResult, type ReplayableBody, streamingProviderCall, type UpstreamCallOptions } from '@floway-dev/provider';

// Hooks for repo-side state transitions. Refresh-token rotations and
// terminal-state transitions go through the repo; access-token and quota
// persistence are handled inside their own helpers, which write the same
// state_json row the same way.
export interface ChatGPTCallEffects {
  persistRefreshTokenRotation(newRefreshToken: string): Promise<void>;
  persistTerminalState(state: 'session_terminated' | 'refresh_failed', message: string): Promise<void>;
}

// Account selection shared by ChatGPT backend calls. Every surface uses the same
// OAuth credential, quota state, terminal-session classification, and refresh
// retry contract; each operation owns its wire body and response decoding.
interface ChatGPTBackendCallBase {
  upstreamId: string;
  account: ChatGPTAccountCredential;
  model: ProviderModel;
  headers: Headers;
  signal?: AbortSignal | undefined;
  effects: ChatGPTCallEffects;
  call: UpstreamCallOptions;
}

export interface CallChatGPTOpenAIResponsesOptions extends ChatGPTBackendCallBase {
  body: Omit<CanonicalOpenAIResponsesPayload, 'model'>;
}

export interface CallChatGPTOpenAIResponsesCompactOptions extends ChatGPTBackendCallBase {
  body: Omit<CanonicalOpenAIResponsesPayload, 'model'>;
}

export interface CallChatGPTAlphaSearchOptions extends ChatGPTBackendCallBase {
  body: Record<string, unknown>;
}

export interface CallChatGPTOpenAIImagesGenerationsOptions extends ChatGPTBackendCallBase {
  body: Omit<OpenAIImagesGenerationsPayload, 'model'>;
  // Null when the account identity carries no plan claim; the image gate
  // treats an unknown plan as allowed (fail open).
  fallbackPlanType: string | undefined;
}

export interface CallChatGPTOpenAIImagesEditsOptions extends ChatGPTBackendCallBase {
  request: OpenAIImagesEditsRequest;
  fallbackPlanType: string | undefined;
}

export const callChatGPTOpenAIResponses = async (opts: CallChatGPTOpenAIResponsesOptions): Promise<ProviderStreamResult<OpenAIResponsesStreamEventEx>> => {
  const prepared = prepareLegacyChatGPTResponsesRequest(opts, 'generate');
  const ready = await prepareChatGPTCall(opts);
  if (!ready.ok) return { ok: false, modelKey: opts.model.id, http: ready.response };
  return await performStreamingOpenAIResponsesCall(opts, prepared, ready.accessToken, false);
};

export const callChatGPTOpenAIResponsesCompact = async (opts: CallChatGPTOpenAIResponsesCompactOptions): Promise<ProviderCompactionResult> => {
  const prepared = prepareLegacyChatGPTResponsesRequest(opts, 'compact');
  const ready = await prepareChatGPTCall(opts);
  if (!ready.ok) return { ok: false, modelKey: opts.model.id, http: ready.response };
  return await performUnaryCompactCall(opts, prepared, ready.accessToken, false);
};

export const callChatGPTAlphaSearch = async (opts: CallChatGPTAlphaSearchOptions): Promise<ProviderCallResult> => {
  const requestId = stringField(opts.body, 'id') ?? uuidV7();
  const normalized = { ...opts, body: { ...opts.body, id: requestId } };
  const ready = await prepareChatGPTCall(normalized);
  if (!ready.ok) return { modelKey: normalized.model.id, http: ready.response };
  return await performAlphaSearchCall(normalized, ready.accessToken, false);
};

const prepareChatGPTImageCall = async (opts: ChatGPTBackendCallBase & { fallbackPlanType: string | undefined }): Promise<{ ok: true; accessToken: ChatGPTAccessTokenEntry; effectivePlan: ChatGPTPlanObservation; turnId: string } | { ok: false; response: Response }> => {
  const ready = await prepareChatGPTCall(opts);
  if (!ready.ok) return { ok: false, response: ready.response };
  // An account whose plan is unknown falls back to a fail-open sentinel: the
  // upstream gate only withholds images from an explicitly `free` plan.
  const effectivePlan = chatgptPlanObservation(ready.accessToken)
    ?? (opts.fallbackPlanType === undefined ? { planType: '' } : { planType: opts.fallbackPlanType });
  if (!chatgptPlanSupportsImages(effectivePlan.planType)) return { ok: false, response: imageUnavailableResult(opts.model.id).http };
  const turnId = trimHeader(opts.headers, 'x-codex-image-turn-id') ?? uuidV7();
  return { ok: true, accessToken: ready.accessToken, effectivePlan, turnId };
};

export const callChatGPTOpenAIImagesGenerations = async (opts: CallChatGPTOpenAIImagesGenerationsOptions): Promise<ProviderCallResult> => {
  const prepared = await prepareChatGPTImageCall(opts);
  if (!prepared.ok) return { modelKey: opts.model.id, http: prepared.response };
  const body = { ...opts.body, model: opts.model.id };
  const request: ChatGPTImageCallRequest = { path: CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH, body, turnId: prepared.turnId };
  return await performImageCall(opts, request, prepared.accessToken, prepared.effectivePlan, false);
};

export const callChatGPTOpenAIImagesEdits = async (opts: CallChatGPTOpenAIImagesEditsOptions): Promise<ProviderCallResult> => {
  const prepared = await prepareChatGPTImageCall(opts);
  if (!prepared.ok) return { modelKey: opts.model.id, http: prepared.response };
  const body = serializeOpenAIImagesEditsJsonPayload(opts.request, opts.model.id);
  const request: ChatGPTImageCallRequest = { path: CHATGPT_OPENAI_IMAGES_EDITS_PATH, body, turnId: prepared.turnId };
  return await performImageCall(opts, request, prepared.accessToken, prepared.effectivePlan, false);
};

const prepareChatGPTCall = async (opts: ChatGPTBackendCallBase): Promise<{ ok: true; accessToken: ChatGPTAccessTokenEntry } | { ok: false; response: Response }> => {
  if (opts.account.state !== 'active') {
    return { ok: false, response: synthetic503(`ChatGPT upstream is ${opts.account.state}`) };
  }

  try {
    const entry = await ensureChatGPTAccessToken(opts.upstreamId, opts.account.chatgptAccountId, refresh => mintAccessToken(opts, refresh));
    return { ok: true, accessToken: entry };
  } catch (err) {
    if (err instanceof ChatGPTOAuthSessionTerminatedError) return await chatgptRefreshFailed(opts, err);
    // An access-only credential with nothing usable left is a configuration
    // problem, not an upstream one, so it reaches the client as our 503 with
    // the re-import instruction rather than as a bare failure.
    if (err instanceof ChatGPTAccessOnlyCredentialError) {
      return { ok: false, response: synthetic503(err.message) };
    }
    throw err;
  }
};

const mintAccessToken = (opts: ChatGPTBackendCallBase, refreshToken: string) =>
  mintChatGPTAccessToken(refreshToken, opts.call.fetcher, opts.effects.persistRefreshTokenRotation);

const trimHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim() ?? '';
  return value.length > 0 ? value : null;
};

const prepareLegacyChatGPTResponsesRequest = (
  opts: CallChatGPTOpenAIResponsesOptions | CallChatGPTOpenAIResponsesCompactOptions,
  action: 'generate' | 'compact',
) => {
  const prepared = prepareChatGPTResponsesRequest({
    body: opts.body,
    deviceId: opts.account.openaiDeviceId,
    model: opts.model,
    modelKey: opts.model.id,
    getHeader: name => trimHeader(opts.headers, name),
  }, action);
  return { ...prepared, body: jsonRequestBody(prepared.body) };
};

type PreparedChatGPTResponsesRequest = ReturnType<typeof prepareLegacyChatGPTResponsesRequest>;

interface ChatGPTHttpCallRequest {
  accessToken: string;
  path: string;
  accept: string;
  body: ReplayableBody;
  identity: ChatGPTRequestIdentity;
  turnMetadataJson: string | null;
  responsesLite: boolean;
}

// One upstream round-trip with quota-header persistence and terminal-401
// classification. The returned Response is what the caller relays:
//   - 2xx: caller decodes the body (SSE for /responses, JSON for /responses/compact)
//   - 429: quota is already snapshotted; return verbatim
//   - 401: an access-only credential preserves the upstream response verbatim
//     and flips the row terminal, because it has nothing to retry with; on a
//     renewable credential `token_invalidated` maps to a synthetic 503 and any
//     other 401 is rebuilt with a re-readable body so the caller can decide to
//     retry with a fresh access token
//   - other: returned verbatim
const postChatGPTJson = async (
  opts: ChatGPTBackendCallBase,
  request: {
    path: string;
    accessToken: string;
    body: Record<string, unknown>;
    headers: Headers;
    quotaPolicy: 'always' | 'when-present';
  },
): Promise<Response> => {
  const { path, accessToken, body, headers, quotaPolicy } = request;
  headers.set('authorization', `Bearer ${accessToken}`);
  // A null account id omits the header rather than sending an empty one: the
  // upstream reads absence as "whichever account this bearer belongs to".
  if (opts.account.chatgptAccountId !== null) {
    headers.set('chatgpt-account-id', opts.account.chatgptAccountId);
  }
  const response = await opts.call.wrapUpstreamCall(() => opts.call.fetcher(`${CHATGPT_BACKEND_BASE}${path}`, {
    method: 'POST',
    headers,
    body: jsonRequestBody(body),
    signal: opts.signal,
  }));
  return await classifyChatGPTHttpResponse(opts, response, quotaPolicy);
};

const dispatchChatGPTHttpCall = async (
  opts: ChatGPTBackendCallBase,
  request: ChatGPTHttpCallRequest,
): Promise<Response> => {
  const { accessToken, path, accept, body, identity, turnMetadataJson, responsesLite } = request;
  const headers = new Headers();
  headers.set('authorization', `Bearer ${accessToken}`);
  if (opts.account.chatgptAccountId !== null) {
    headers.set('chatgpt-account-id', opts.account.chatgptAccountId);
  }
  headers.set('originator', CHATGPT_ORIGINATOR);
  headers.set('user-agent', CHATGPT_USER_AGENT);
  headers.set('version', CHATGPT_CLI_VERSION);
  headers.set('accept', accept);
  headers.set('content-type', 'application/json');
  headers.set('session-id', identity.sessionId);
  headers.set('thread-id', identity.threadId);
  headers.set('x-client-request-id', identity.clientRequestId);
  headers.set('x-codex-window-id', identity.windowId);
  if (turnMetadataJson !== null) headers.set('x-codex-turn-metadata', turnMetadataJson);
  if (responsesLite) headers.set(CHATGPT_RESPONSES_LITE_HEADER, 'true');

  const response = await opts.call.wrapUpstreamCall(() => opts.call.fetcher(`${CHATGPT_BACKEND_BASE}${path}`, {
    method: 'POST',
    headers,
    body,
    signal: opts.signal,
  }));

  return await classifyChatGPTHttpResponse(opts, response);
};

const classifyChatGPTHttpResponse = async (
  opts: ChatGPTBackendCallBase,
  response: Response,
  quotaPolicy: 'always' | 'when-present' = 'always',
): Promise<Response> => {
  if (response.ok) {
    persistChatGPTQuotaObservation(opts, response, false, quotaPolicy);
    return response;
  }

  if (response.status === 429) {
    persistChatGPTQuotaObservation(opts, response, true, quotaPolicy);
    return response;
  }

  if (response.status === 401) {
    const bodyText = await response.text();
    const { code, message } = parseUpstreamError(bodyText);
    if (opts.account.refresh_token === null) {
      // An access-only credential cannot recover from a rejected bearer, so
      // the row is marked best-effort — but a storage failure must never
      // replace the upstream status, headers, or body the caller needs to
      // diagnose what happened.
      try {
        await opts.effects.persistTerminalState('session_terminated', message);
      } catch {
        // The upstream response remains authoritative.
      }
      return new Response(bodyText, { status: 401, statusText: response.statusText, headers: response.headers });
    }
    if (code === 'token_invalidated') {
      await opts.effects.persistTerminalState('session_terminated', message);
      return synthetic503(`ChatGPT session terminated: ${message}`);
    }
    return new Response(bodyText, { status: 401, statusText: response.statusText, headers: response.headers });
  }

  return response;
};

const persistChatGPTQuotaObservation = (
  opts: ChatGPTBackendCallBase,
  response: Response,
  isRateLimited: boolean,
  policy: 'always' | 'when-present',
): void => {
  const snapshot = parseChatGPTQuotaHeaders(response.headers, { now: new Date(), isRateLimited });
  if (policy === 'when-present' && !hasChatGPTQuotaReading(snapshot)) return;
  registerBackgroundWrite(opts, putChatGPTQuota(opts.upstreamId, opts.account.chatgptAccountId, snapshot));
};

const dispatchChatGPTImageCall = async (
  opts: ChatGPTBackendCallBase,
  request: ChatGPTImageCallDispatchRequest,
): Promise<Response> => {
  const { accessToken, path, body, turnId } = request;
  const headers = new Headers({
    originator: trimHeader(opts.headers, 'originator') ?? CHATGPT_ORIGINATOR,
    'user-agent': CHATGPT_USER_AGENT,
    version: CHATGPT_CLI_VERSION,
    accept: 'application/json',
    'content-type': 'application/json',
    'x-codex-image-turn-id': turnId,
  });
  return await postChatGPTJson(opts, { path, accessToken, body, headers, quotaPolicy: 'when-present' });
};

// Recover from a 401 without deleting a sibling's newer credential: invalidate
// only the exact token that failed, reuse a winner already stored by another
// request, otherwise force a fresh coalesced mint. The resulting CAS write is
// awaited because it also resolves the latest plan observation for the retry.
//
// Every call site gates this behind `refresh_token !== null`: an access-only
// credential has nothing to re-mint from, its 401 was already classified as
// terminal in `classifyChatGPTHttpResponse`, and the verbatim upstream response
// is what reaches the client.
const refreshAccessTokenForRetry = async (
  opts: ChatGPTBackendCallBase,
  failedEntry: ChatGPTAccessTokenEntry,
  fallbackPlan?: ChatGPTPlanObservation,
): Promise<{ ok: true; accessToken: ChatGPTAccessTokenEntry } | { ok: false; response: Response }> => {
  try {
    const retained = await invalidateChatGPTAccessToken(
      opts.upstreamId,
      opts.account.chatgptAccountId,
      failedEntry.token,
    );
    if (retained !== null) return { ok: true, accessToken: retained };
    const effective = await ensureChatGPTAccessToken(
      opts.upstreamId,
      opts.account.chatgptAccountId,
      async refreshToken => {
        const minted = await mintAccessToken(opts, refreshToken);
        return mergeRetryPlan(minted, fallbackPlan ?? chatgptPlanObservation(failedEntry) ?? undefined);
      },
      true,
    );
    return { ok: true, accessToken: effective };
  } catch (err) {
    if (err instanceof ChatGPTOAuthSessionTerminatedError) return await chatgptRefreshFailed(opts, err);
    throw err;
  }
};

// The 401-retry gate's per-call inputs. The dispatchers bundle their access
// token, the response they saw, the recursion switch, and the retry / failure
// callbacks in one object rather than threading six positional arguments.
interface RetryChatGPTAccess401Options<T> {
  accessToken: ChatGPTAccessTokenEntry;
  response: Response | null;
  alreadyRetried: boolean;
  run: (fresh: ChatGPTAccessTokenEntry) => Promise<T>;
  onRefreshFailure: (response: Response) => T;
  fallbackPlan?: ChatGPTPlanObservation;
}

// The 401 retry gate every call dispatcher shares: on a renewable credential
// that has not already been retried, rotate the failed access token and re-run
// the operation once; if the refresh fails, relay the dispatcher's own failure
// result. The gate — a 401 on a credential with a refresh token, not already
// retried — is folded in here, so callers pass the response they saw and only
// branch on the retried outcome. An access-only credential's 401 is already
// classified terminal in `classifyChatGPTHttpResponse`, and the verbatim upstream
// response reaches the client.
const retryChatGPTAccess401 = async <T>(
  opts: ChatGPTBackendCallBase,
  options: RetryChatGPTAccess401Options<T>,
): Promise<{ retried: true; value: T } | { retried: false }> => {
  const { accessToken, response, alreadyRetried, run, onRefreshFailure, fallbackPlan } = options;
  if (response?.status !== 401 || opts.account.refresh_token === null || alreadyRetried) return { retried: false };
  const fresh = await refreshAccessTokenForRetry(opts, accessToken, fallbackPlan);
  if (!fresh.ok) return { retried: true, value: onRefreshFailure(fresh.response) };
  return { retried: true, value: await run(fresh.accessToken) };
};

const mergeRetryPlan = (
  entry: ChatGPTAccessTokenEntry,
  fallback: ChatGPTPlanObservation | undefined,
): ChatGPTAccessTokenEntry => {
  if (entry.planType !== undefined || fallback === undefined) return entry;
  return {
    ...entry,
    planType: fallback.planType,
    ...(fallback.observedAt === undefined ? {} : { planObservedAt: fallback.observedAt }),
  };
};

const performStreamingOpenAIResponsesCall = async (
  opts: CallChatGPTOpenAIResponsesOptions,
  prepared: PreparedChatGPTResponsesRequest,
  accessToken: ChatGPTAccessTokenEntry,
  alreadyRetried: boolean,
): Promise<ProviderStreamResult<OpenAIResponsesStreamEventEx>> => {
  const upstreamFetch = dispatchChatGPTHttpCall(opts, {
    accessToken: accessToken.token,
    path: CHATGPT_OPENAI_RESPONSES_PATH,
    accept: 'text/event-stream',
    body: prepared.body,
    identity: prepared.identity,
    turnMetadataJson: prepared.turnMetadataJson.header,
    responsesLite: prepared.responsesLite,
  }).then(ensureSseContentType);

  const result = await streamingProviderCall(
    upstreamFetch,
    (stream, parserOpts) => {
      const frames = (async function* () {
        for await (const frame of parseOpenAIResponsesStream(stream, parserOpts)) {
          if (frame.type === 'error') throw new Error(frame.cause.message, { cause: frame.cause.cause });
          yield frame;
        }
      })();
      return restoreChatGPTResponsesOutput(Object.keys(prepared.movedFields).length === 0
        ? frames
        : projectMovedChatGPTResponsesFields(frames, prepared.movedFields));
    },
    opts.model.id,
    opts.signal,
  );

  const attempt = await retryChatGPTAccess401(
    opts,
    {
      accessToken,
      response: result.ok ? null : result.http,
      alreadyRetried,
      run: fresh => performStreamingOpenAIResponsesCall(opts, prepared, fresh, true),
      onRefreshFailure: resp => ({ ok: false as const, modelKey: opts.model.id, http: resp }),
    },
  );
  if (attempt.retried) return attempt.value;

  return result;
};

const performUnaryCompactCall = async (
  opts: CallChatGPTOpenAIResponsesCompactOptions,
  prepared: PreparedChatGPTResponsesRequest,
  accessToken: ChatGPTAccessTokenEntry,
  alreadyRetried: boolean,
): Promise<ProviderCompactionResult> => {
  const response = await dispatchChatGPTHttpCall(opts, {
    accessToken: accessToken.token,
    path: CHATGPT_OPENAI_RESPONSES_COMPACT_PATH,
    accept: 'application/json',
    body: prepared.body,
    identity: prepared.identity,
    turnMetadataJson: prepared.turnMetadataJson.header,
    responsesLite: prepared.responsesLite,
  });

  const attempt = await retryChatGPTAccess401(
    opts,
    {
      accessToken,
      response,
      alreadyRetried,
      run: fresh => performUnaryCompactCall(opts, prepared, fresh, true),
      onRefreshFailure: resp => ({ ok: false as const, modelKey: opts.model.id, http: resp }),
    },
  );
  if (attempt.retried) return attempt.value;

  if (!response.ok) return { ok: false, modelKey: opts.model.id, http: response };

  const result = await response.json() as OpenAIResponsesCompactionResultEx;
  return {
    ok: true,
    modelKey: opts.model.id,
    http: { status: response.status, headers: response.headers },
    result,
  };
};

const performAlphaSearchCall = async (
  opts: CallChatGPTAlphaSearchOptions,
  accessToken: ChatGPTAccessTokenEntry,
  alreadyRetried: boolean,
): Promise<ProviderCallResult> => {
  const requestId = stringField(opts.body, 'id');
  if (requestId === null) throw new Error('Normalized ChatGPT alpha search request is missing id');
  const identity: ChatGPTRequestIdentity = {
    installationId: opts.account.openaiDeviceId,
    sessionId: requestId,
    threadId: requestId,
    clientRequestId: requestId,
    turnId: uuidV7(),
    windowId: `${requestId}:0`,
  };
  const turnMetadataJson = trimHeader(opts.headers, 'x-codex-turn-metadata');
  const response = await dispatchChatGPTHttpCall(opts, {
    accessToken: accessToken.token,
    path: CHATGPT_ALPHA_SEARCH_PATH,
    accept: 'application/json',
    body: jsonRequestBody({ ...opts.body, model: opts.model.id }),
    identity,
    turnMetadataJson,
    responsesLite: false,
  });

  const attempt = await retryChatGPTAccess401(
    opts,
    {
      accessToken,
      response,
      alreadyRetried,
      run: fresh => performAlphaSearchCall(opts, fresh, true),
      onRefreshFailure: resp => ({ modelKey: opts.model.id, http: resp }),
    },
  );
  if (attempt.retried) return attempt.value;
  return { modelKey: opts.model.id, http: response };
};

// The fixed per-request inputs for one ChatGPT image call. The path, body, and
// turn id are stable for the whole call, so the entry sites bundle them once
// and retries re-pass the same bundle rather than threading three positional
// arguments on every recursion.
interface ChatGPTImageCallRequest {
  path: string;
  body: Record<string, unknown>;
  turnId: string;
}

// The image-call bundle plus the resolved bearer, mirroring ChatGPTHttpCallRequest
// for the HTTP call path. The entry sites bundle the stable path/body/turnId
// once; retries re-pass the same bundle with a fresh access token rather than
// threading four positional arguments on every recursion.
type ChatGPTImageCallDispatchRequest = ChatGPTImageCallRequest & { accessToken: string };

const performImageCall = async (
  opts: ChatGPTBackendCallBase,
  request: ChatGPTImageCallRequest,
  accessToken: ChatGPTAccessTokenEntry,
  effectivePlan: ChatGPTPlanObservation,
  alreadyRetried: boolean,
): Promise<ProviderCallResult> => {
  const response = await dispatchChatGPTImageCall(opts, { accessToken: accessToken.token, ...request });
  const attempt = await retryChatGPTAccess401(
    opts,
    {
      accessToken,
      response,
      alreadyRetried,
      run: async entry => {
        const refreshedPlan = chatgptPlanObservation(entry) ?? effectivePlan;
        if (!chatgptPlanSupportsImages(refreshedPlan.planType)) return imageUnavailableResult(opts.model.id);
        return await performImageCall(opts, request, entry, refreshedPlan, true);
      },
      onRefreshFailure: resp => ({ modelKey: opts.model.id, http: resp }),
      fallbackPlan: effectivePlan,
    },
  );
  if (attempt.retried) return attempt.value;
  return { modelKey: opts.model.id, http: response };
};

const parseUpstreamError = (rawText: string): { code: string | null; message: string } => {
  try {
    const obj = JSON.parse(rawText) as { error?: { code?: unknown; message?: unknown }; detail?: unknown };
    const code = obj.error && typeof obj.error === 'object' && typeof obj.error.code === 'string' ? obj.error.code : null;
    const message = obj.error && typeof obj.error === 'object' && typeof obj.error.message === 'string'
      ? obj.error.message
      : typeof obj.detail === 'string' ? obj.detail : rawText.slice(0, 256);
    return { code, message };
  } catch {
    return { code: null, message: rawText.slice(0, 256) };
  }
};

const imageUnavailableResult = (modelKey: string): ProviderCallResult => ({
  modelKey,
  http: new Response(JSON.stringify({
    error: {
      type: 'image_tools_unavailable',
      message: 'ChatGPT Free accounts do not provide Codex image tools.',
    },
  }), { status: 403, headers: { 'content-type': 'application/json' } }),
});

const synthetic503 = (message: string): Response => new Response(JSON.stringify({ error: { type: 'chatgpt_upstream_unavailable', message } }), {
  status: 503,
  headers: { 'content-type': 'application/json' },
});

const chatgptRefreshFailed = async (opts: ChatGPTBackendCallBase, err: ChatGPTOAuthSessionTerminatedError): Promise<{ ok: false; response: Response }> => {
  await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
  return { ok: false, response: synthetic503(`ChatGPT refresh failed: ${err.upstreamMessage}`) };
};

// Codex backend serves SSE without setting `content-type: text/event-stream`
// (observed in production: only x-codex-* + standard CDN headers come back).
// The shared `streamingProviderCall` rejects 2xx responses lacking the SSE
// content-type as a contract violation, so we synthesize the header on the
// way through. Body stream is preserved verbatim.
const ensureSseContentType = (response: Response): Response => {
  if (!response.ok || isEventStreamMediaType(response.headers.get('content-type'))) return response;
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/event-stream');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

// Hand best-effort writes to waitUntil so workerd does not cancel them when
// the streaming response returns; the swallow guards against recoverable
// noise (transient storage errors, a state_json write that lost every one of
// its retries) tripping the request.
const registerBackgroundWrite = (opts: ChatGPTBackendCallBase, write: Promise<void>): void => {
  opts.call.waitUntil(write.catch(() => {}));
};
