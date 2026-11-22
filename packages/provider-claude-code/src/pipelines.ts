import { ensureClaudeCodeAccessToken, invalidateClaudeCodeAccessToken, type EnsuredAccessToken } from './access-token.ts';
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth.ts';
import { isClaudeCodeShapedRequest } from './detection.ts';
import {
  detectTerminalSentinel,
  observedClaudeCodeMessagesStream,
  persistQuotaSnapshot,
  persistTerminalAccountState,
  STREAM_DIAGNOSTIC_FRAME_DATA_CHARS,
  STREAM_DIAGNOSTIC_FRAME_LIMIT,
  type StreamDiagnosticFrame,
} from './fetch.ts';
import { pickClaudeCodeHeaders } from './headers.ts';
import { backfillRequiredFieldsPayload } from './interceptors/anthropic-messages/backfill-required-fields.ts';
import { hoistUserSystemToMessagesPayload } from './interceptors/anthropic-messages/hoist-user-system-to-messages.ts';
import { injectBillingBlockPayload } from './interceptors/anthropic-messages/inject-billing-block.ts';
import { injectDefaultTemplatePayload } from './interceptors/anthropic-messages/inject-default-template.ts';
import { injectIdentityBlockPayload } from './interceptors/anthropic-messages/inject-identity-block.ts';
import { synthesizeMetadataUserIdPayload } from './interceptors/anthropic-messages/synthesize-metadata-user-id.ts';
import { logWarn } from './log.ts';
import type { ClaudeCodeProviderData } from './models.ts';
import { claudeCodeRateLimitedUntil, parseClaudeCodeQuotaHeaders } from './quota.ts';
import { readClaudeCodeUpstreamState } from './state.ts';
import { defineRequestStage, defineStage, pipeline, secret } from '@floway-dev/pipeline';
import type { HeaderEntry, Secret, StageEnv } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import type { SseFrame } from '@floway-dev/protocols/common';
import {
  getProviderRepo,
  headersForAnthropicMessagesCall,
  headersFromEntries,
  httpTerminal,
  parseUpstreamSseOutcome,
  syntheticJsonOutcome,
  wrapSensitiveHeaderEntries,
} from '@floway-dev/provider';
import type {
  HttpOutcome,
  ProviderPipelineAnthropicMessagesInput,
  ProviderPipelineServices,
  ProviderPipelineStreamOutcome,
  ProviderPipelines,
  UpstreamRecord,
  UpstreamHttpRequest,
} from '@floway-dev/provider';

type PipelineEnv = StageEnv<ProviderPipelineServices>;
type MessagePayload = Omit<AnthropicMessagesPayload, 'model'>;
type MessagesInput = ProviderPipelineAnthropicMessagesInput;
type ShapedFacts = MessagesInput & {
  readonly 'claudeCode.shaped': boolean;
};
type AccessFacts = ShapedFacts & { readonly 'claudeCode.accessToken': Secret<string> };
type MessagesOutcome = ProviderPipelineStreamOutcome<AnthropicMessagesStreamEventEx>;

const ANTHROPIC_MESSAGES_ORIGIN = 'https://api.anthropic.com';
const ANTHROPIC_MESSAGES_PATH = '/v1/messages';

const upstreamModelIdOf = (facts: Pick<ShapedFacts, 'provider.model'>): string =>
  (facts['provider.model'].providerData as ClaudeCodeProviderData).upstreamModelId;

const revealHeaderEntries = (entries: readonly HeaderEntry[]): [string, string][] =>
  entries.map(([name, value]) => [name, typeof value === 'string' ? value : value.reveal()]);

const detectClaudeCodeShape = defineStage<
  MessagesInput,
  { readonly 'claudeCode.shaped': boolean },
  MessagesOutcome,
  MessagesOutcome,
  never,
  ProviderPipelineServices
>({
  name: 'detectClaudeCodeShape',
  provides: ['claudeCode.shaped'],
  execute: async (facts, next) => {
    const headers = new Headers(headersForAnthropicMessagesCall(
      revealHeaderEntries(facts['request.inboundHeaders']),
      facts['request.anthropicBeta'],
    ).map(([name, value]) => [name, value]));
    const shaped = isClaudeCodeShapedRequest({
      headers,
      body: { ...facts['request.payload'], model: facts['provider.model'].id },
    });
    return await next({ 'claudeCode.shaped': shaped });
  },
});

const shapingStage = (
  name: string,
  transform: (facts: ShapedFacts) => MessagePayload,
) => defineStage<
  ShapedFacts,
  Record<never, never>,
  MessagesOutcome,
  MessagesOutcome,
  never,
  ProviderPipelineServices
>({
  name,
  execute: async (facts, next) => {
    if (facts['claudeCode.shaped']) return await next();
    return await next({ 'request.payload': { ...transform(facts) } });
  },
});

const backfillRequiredFields = shapingStage('backfillRequiredFields', facts =>
  backfillRequiredFieldsPayload(facts['request.payload'], facts['provider.model']));

const synthesizeMetadataUserId = (record: UpstreamRecord) => shapingStage('synthesizeMetadataUserId', facts =>
  synthesizeMetadataUserIdPayload(facts['request.payload'], record.id));

const hoistUserSystemToMessages = shapingStage('hoistUserSystemToMessages', facts =>
  hoistUserSystemToMessagesPayload(facts['request.payload']));

const injectBillingBlock = shapingStage('injectBillingBlock', facts =>
  injectBillingBlockPayload(facts['request.payload']));

const injectIdentityBlock = shapingStage('injectIdentityBlock', facts =>
  injectIdentityBlockPayload(facts['request.payload']));

const injectDefaultTemplate = shapingStage('injectDefaultTemplate', facts =>
  injectDefaultTemplatePayload(facts['request.payload']));

const accessTokenFor = (ensured: EnsuredAccessToken): Secret<string> => secret(`Bearer ${ensured.entry.token}`);

const ensureAccessToken = async (
  record: UpstreamRecord,
  upstreamModelId: string,
  env: PipelineEnv,
): Promise<{ readonly ok: true; readonly ensured: EnsuredAccessToken } | { readonly ok: false; readonly http: HttpOutcome }> => {
  try {
    return {
      ok: true,
      ensured: await ensureClaudeCodeAccessToken({
        upstreamId: record.id,
        repo: getProviderRepo().upstreams,
        fetcher: env.fetcherFor(record.id),
      }),
    };
  } catch (error) {
    if (!(error instanceof ClaudeCodeOAuthSessionTerminatedError)) throw error;
    return {
      ok: false,
      http: syntheticJsonOutcome(env, {
        status: 503,
        body: {
          error: {
            type: 'claude_code_upstream_unavailable',
            message: `Claude Code refresh failed: ${error.upstreamMessage}`,
          },
        },
        modelKey: upstreamModelId,
      }),
    };
  }
};

const observeQuota = (http: HttpOutcome, record: UpstreamRecord, upstreamModelId: string, env: PipelineEnv): void => {
  if ((http.status < 200 || http.status >= 300) && http.status !== 429) return;
  const snapshot = parseClaudeCodeQuotaHeaders(headersFromEntries(http.headers));
  if (Object.keys(snapshot.raw).length === 0) return;
  env.waitUntil(persistQuotaSnapshot(record.id, upstreamModelId, snapshot).catch(error => {
    logWarn('claude_code_quota_persist_failed', {
      upstream_id: record.id,
      error: String(error),
    });
  }));
};

const observeTerminalSentinel = (
  http: HttpOutcome,
  record: UpstreamRecord,
  env: PipelineEnv,
): HttpOutcome => {
  if ((http.status !== 400 && http.status !== 403) || http.body === null) return http;
  const [forward, probe] = env.teeStream(http.body, {
    labels: ['claude-code.sentinel.forward', 'claude-code.sentinel.probe'],
  });
  env.consumeInBackground(probe, async source => {
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    try {
      for await (const chunk of source) chunks.push(decoder.decode(chunk, { stream: true }));
      chunks.push(decoder.decode());
    } catch (error) {
      logWarn('claude_code_terminal_sentinel_body_read_failed', {
        upstream_id: record.id,
        upstream_status: http.status,
        error: String(error),
      });
      return;
    }
    const text = chunks.join('');
    const terminalMessage = detectTerminalSentinel(http.status, text);
    if (terminalMessage === null) return;
    const reason = http.status === 400 ? 'org_disabled_400_sentinel' : 'org_banned_403_sentinel';
    logWarn('claude_code_terminal_sentinel_detected', {
      upstream_id: record.id,
      upstream_status: http.status,
      reason,
    });
    await persistTerminalAccountState(
      record.id,
      terminalMessage,
      reason,
      http.status,
    ).catch(error => logWarn('claude_code_terminal_sentinel_persist_failed', {
      upstream_id: record.id,
      error: String(error),
    }));
  });
  return { ...http, body: forward };
};

const parseObservedStream = async (
  http: HttpOutcome,
  record: UpstreamRecord,
  env: PipelineEnv,
): Promise<MessagesOutcome> => {
  let rawSseFrameCount = 0;
  const rawSseFrames: StreamDiagnosticFrame[] = [];
  const observeRawSseFrame = (frame: SseFrame): void => {
    rawSseFrameCount++;
    rawSseFrames.push({
      event: frame.event ?? null,
      data: frame.data.length > STREAM_DIAGNOSTIC_FRAME_DATA_CHARS
        ? `${frame.data.slice(0, STREAM_DIAGNOSTIC_FRAME_DATA_CHARS - 3)}...`
        : frame.data,
    });
    if (rawSseFrames.length > STREAM_DIAGNOSTIC_FRAME_LIMIT) rawSseFrames.shift();
  };
  const parsed = await parseUpstreamSseOutcome(
    http,
    (body, options) => parseAnthropicMessagesStream(body, { ...options, onSseFrame: observeRawSseFrame }),
    env,
  );
  if (!parsed.ok) return parsed;
  return {
    ...parsed,
    events: env.wrapStream(parsed.events, {
      label: 'claude-code.messages.observed',
      transform: (source, signal) => observedClaudeCodeMessagesStream(source, {
        upstreamId: record.id,
        model: parsed.modelKey,
        headers: headersFromEntries(http.headers),
        signal,
        frames: rawSseFrames,
        rawFrameCount: () => rawSseFrameCount,
        warn: async (message, fields) => env.log.warn(message, fields),
      }),
    }),
  };
};

const authenticateClaudeCode = (record: UpstreamRecord) => defineStage<
  ShapedFacts,
  { readonly 'claudeCode.accessToken': Secret<string> },
  HttpOutcome,
  MessagesOutcome,
  never,
  ProviderPipelineServices
>({
  name: 'authenticateClaudeCode',
  provides: ['claudeCode.accessToken'],
  execute: async (facts, next, env) => {
    const upstreamModelId = upstreamModelIdOf(facts);
    const current = await getProviderRepo().upstreams.getById(record.id);
    if (current === null) throw new Error(`Claude Code upstream ${record.id} disappeared mid-request`);
    const account = readClaudeCodeUpstreamState(current.state).accounts[0];
    if (account.state !== 'active') {
      return {
        ok: false,
        modelKey: upstreamModelId,
        http: syntheticJsonOutcome(env, {
          status: 503,
          body: {
            error: {
              type: 'claude_code_upstream_unavailable',
              message: `Claude Code account is ${account.state}: ${account.stateMessage}`,
            },
          },
          modelKey: upstreamModelId,
        }),
      };
    }
    const now = Date.now();
    const retryAt = claudeCodeRateLimitedUntil(account.quotaSnapshot, now, upstreamModelId);
    if (retryAt !== null) {
      const retryAfter = Math.max(0, Math.ceil((Date.parse(retryAt) - now) / 1000));
      return {
        ok: false,
        modelKey: upstreamModelId,
        http: syntheticJsonOutcome(env, {
          status: 429,
          headers: [['retry-after', String(retryAfter)]],
          body: {
            error: {
              type: 'claude_code_rate_limited',
              message: `Claude Code upstream rate-limited until ${retryAt}`,
              retry_at: retryAt,
            },
          },
          modelKey: upstreamModelId,
        }),
      };
    }

    let ensured = await ensureAccessToken(record, upstreamModelId, env);
    if (!ensured.ok) return { ok: false, modelKey: upstreamModelId, http: ensured.http };
    let alreadyRetried = false;
    for (;;) {
      let http = await next({ 'claudeCode.accessToken': accessTokenFor(ensured.ensured) });
      if (http.status === 401 && !ensured.ensured.freshlyMinted && !alreadyRetried) {
        if (http.body !== null) await env.discard(http.body);
        alreadyRetried = true;
        await invalidateClaudeCodeAccessToken({ upstreamId: record.id, repo: getProviderRepo().upstreams });
        ensured = await ensureAccessToken(record, upstreamModelId, env);
        if (!ensured.ok) return { ok: false, modelKey: upstreamModelId, http: ensured.http };
        continue;
      }
      observeQuota(http, record, upstreamModelId, env);
      http = observeTerminalSentinel(http, record, env);
      return await parseObservedStream(http, record, env);
    }
  },
});

export const wireClaudeCodeRequest = defineRequestStage<
  AccessFacts,
  { readonly 'request.http': UpstreamHttpRequest; readonly 'provider.modelKey': string },
  never,
  ProviderPipelineServices
>({
  name: 'wireClaudeCodeRequest',
  provides: ['request.http', 'provider.modelKey'],
  execute: async (facts, next) => {
    const upstreamModelId = upstreamModelIdOf(facts);
    const inbound = facts['request.inboundHeaders'];
    const shapedHeaders = (() => {
      const withoutBeta = inbound.filter(([name]) => name.toLowerCase() !== 'anthropic-beta');
      const beta = facts['request.anthropicBeta'].filter(value => value.length > 0).join(',');
      const withContentType: readonly HeaderEntry[] = withoutBeta.some(([name]) => name.toLowerCase() === 'content-type')
        ? withoutBeta
        : [...withoutBeta, ['content-type', 'application/json']];
      return wrapSensitiveHeaderEntries([
        ...withContentType,
        ...(beta === '' ? [] : [['anthropic-beta', beta] as const]),
        ['authorization', facts['claudeCode.accessToken']],
      ]);
    })();
    const headers: readonly HeaderEntry[] = facts['claudeCode.shaped']
      ? shapedHeaders
      : [
          ...Object.entries(pickClaudeCodeHeaders(upstreamModelId)),
          ['authorization', facts['claudeCode.accessToken']],
        ];
    return await next({
      'request.http': {
        method: 'POST',
        url: {
          origin: ANTHROPIC_MESSAGES_ORIGIN,
          pathname: ANTHROPIC_MESSAGES_PATH,
          query: [['beta', 'true']],
        },
        headers,
        body: {
          kind: 'json',
          value: { ...facts['request.payload'], model: upstreamModelId, stream: true },
        },
      },
      'provider.modelKey': upstreamModelId,
    });
  },
});

export const createClaudeCodePipelines = (record: UpstreamRecord): ProviderPipelines => ({
  anthropicMessages: pipeline<MessagesInput>('claude-code.anthropic-messages')
    .use(detectClaudeCodeShape)
    .use(backfillRequiredFields)
    .use(synthesizeMetadataUserId(record))
    .use(hoistUserSystemToMessages)
    .use(injectBillingBlock)
    .use(injectIdentityBlock)
    .use(injectDefaultTemplate)
    .use(authenticateClaudeCode(record))
    .use(wireClaudeCodeRequest)
    .end(httpTerminal(record.id)),
});
