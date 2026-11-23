import { isObject } from './auth/guards.ts';
import { ChatGPTOAuthSessionTerminatedError } from './auth/oauth.ts';
import type { ChatGPTUpstreamFacts } from './config.ts';
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
import { injectDefaultInstructions } from './responses-default-instructions.ts';
import { projectMovedChatGPTResponsesFields } from './responses-lite.ts';
import { restoreChatGPTResponsesOutput } from './responses-output.ts';
import { prepareChatGPTResponsesRequest, stringField, trimHeader, type ChatGPTRequestIdentity } from './responses-request.ts';
import { stripUnsupportedFields } from './responses-strip-unsupported-fields.ts';
import type { ChatGPTPersistence, ChatGPTService, ChatGPTServices } from './service.ts';
import { compose, defineStage, secret, type Scope } from '@floway-dev/pipeline';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import {
  deleteHeader, getHeader, httpTerminal, httpUrl, mergeHeaders, parseHttpOutcomeStage, parseResponsesStage, rewriteHttpRequest,
  serializeOpenAIImagesEditsJsonPayload, setHeader, stripHttpHeaders,
  type HeaderEntry, type HttpOutcome, type HttpResponseFacts, type OpenAIImagesEditsRequest,
  type ProviderAlphaSearchOutput, type ProviderBaseOutput, type ProviderInput, type ProviderOpenAIImagesEditsOutput,
  type ProviderOpenAIImagesGenerationsOutput, type ProviderOpenAIResponsesOutput, type ProviderPipelines, type ProviderResponsesInput,
} from '@floway-dev/provider';

type ResponsesInput = ProviderResponsesInput<ChatGPTUpstreamFacts>;
type ResponsesOutcome = ProviderOpenAIResponsesOutput['response.openaiResponses'];
type UpstreamInput = { readonly 'provider.upstream': ChatGPTUpstreamFacts };
type HttpOutput = Pick<ProviderBaseOutput, 'response.http'>;
type Failure = Extract<HttpOutcome, { kind: 'error' }>;
type Success = { readonly kind: 'ok' | 'stream' | 'result' };
type BackendOutcome<Result extends Success> = Result | Failure;
type Parsed<Key extends string, Result extends Success> = HttpOutput & Readonly<Record<Key, BackendOutcome<Result>>>;
type Access = Awaited<ReturnType<ChatGPTService['access']>>;
type ActiveAccess = Extract<Access, { kind: 'active' }>;
type RefusedAccess = Extract<Access, { kind: 'error' }>;

interface BackendRequest<Result extends Success> {
  readonly path: string;
  readonly headers: readonly HeaderEntry[];
  readonly body: Record<string, unknown>;
  readonly project?: (outcome: BackendOutcome<Result>, scope: Scope<ChatGPTServices>) => BackendOutcome<Result>;
}

const plainHeaders = (entries: readonly HeaderEntry[]): Headers =>
  new Headers(entries.map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : value.reveal()]));

const parseUpstreamError = (parsed: unknown): { code: string | null; message: string } => {
  const root = isObject(parsed) ? parsed : {};
  const error = isObject(root.error) ? root.error : {};
  const message = typeof error.message === 'string' ? error.message
    : typeof root.detail === 'string' ? root.detail
      : JSON.stringify(parsed).slice(0, 256);
  return { code: typeof error.code === 'string' ? error.code : null, message };
};

const deferPersistence = (
  name: string, upstreamId: string, write: Promise<ChatGPTPersistence>, scope: Scope<ChatGPTServices>,
): void => {
  scope.defer(name, write.then(result => {
    if (!result.persisted) scope.log.warn(`${name} persistence failed`, { upstreamId, error: result.error });
    return result;
  }));
};

const backendStage = <Input extends ProviderInput<ChatGPTUpstreamFacts, unknown>, Key extends string, Result extends Success>(options: {
  readonly name: string;
  readonly key: Key;
  readonly action: readonly (keyof Input & string)[];
  readonly operation: 'codex' | 'images';
  readonly prepare: (facts: Input, access: ActiveAccess) => BackendRequest<Result>;
}) => defineStage<Input, Input, Parsed<Key, Result>, ProviderBaseOutput & Parsed<Key, Result>, ChatGPTServices>({
  name: options.name,
  through: {
    request: { needs: ['provider.upstream', 'provider.model', 'request.http', 'request.payload', ...options.action], consumes: [], provides: ['request.http'] },
    response: { needs: ['response.http', options.key], consumes: [], provides: ['response.http', 'response.modelKey', options.key] },
  },
  return: { provides: ['response.http', 'response.modelKey', options.key] },
  async execute(facts, scope) {
    const upstream = facts['provider.upstream'];
    const modelKey = facts['provider.model'].id;
    const service = scope.services.chatgpt;
    const startedAt = scope.clock();
    const fetcher = scope.services.fetcher(upstream.id);
    const getAccess = (rejectedToken?: string) =>
      service.access({ upstream, fetcher, now: Date.now(), signal: scope.signal, operation: options.operation, rejectedToken });
    const output = (http: HttpResponseFacts, outcome: BackendOutcome<Result>) =>
      ({ 'response.http': http, 'response.modelKey': modelKey, [options.key]: outcome } as ProviderBaseOutput & Parsed<Key, Result>);
    const refused = (access: RefusedAccess) => {
      if (access.terminal !== undefined) deferPersistence('chatgpt-terminal-state', upstream.id, access.terminal, scope);
      const message = access.error instanceof ChatGPTOAuthSessionTerminatedError
        ? `ChatGPT refresh failed: ${access.error.upstreamMessage}` : access.error.message;
      const headers: HeaderEntry[] = [['content-type', 'application/json']];
      if (access.retryAfter !== undefined) headers.push(['retry-after', access.retryAfter]);
      return output({
        status: access.status,
        statusText: '',
        headers,
        body: null,
        timing: { startedAt, headersAt: scope.clock() },
        ...(access.transportError === undefined ? {} : { transportError: access.transportError }),
      }, { kind: 'error', source: access.source, error: { error: { type: access.type, message } } });
    };
    const firstAccess = await getAccess();
    if (firstAccess.kind === 'error') return refused(firstAccess);

    const backend = options.prepare(facts, firstAccess);
    const request = rewriteHttpRequest(facts['request.http'], {
      method: 'POST',
      url: httpUrl(`${CHATGPT_BACKEND_BASE}${backend.path}`),
      headers: headers => {
        let cleaned = deleteHeader(deleteHeader(headers, CHATGPT_RESPONSES_LITE_HEADER), 'chatgpt-account-id');
        cleaned = deleteHeader(cleaned, 'x-codex-turn-metadata');
        const accountId = upstream.config.account.chatgptAccountId;
        if (accountId !== null) cleaned = setHeader(cleaned, 'chatgpt-account-id', accountId);
        return mergeHeaders(cleaned, backend.headers);
      },
      body: { kind: 'json', value: backend.body },
    });
    const dispatch = (access: ActiveAccess) => scope.next({
      ...facts,
      'request.http': { ...request, headers: setHeader(request.headers, 'authorization', secret(`Bearer ${access.token.reveal()}`)) },
    });
    const finish = (back: Parsed<Key, Result>) => {
      const outcome = back[options.key];
      return {
        ...back,
        ...output(back['response.http'], backend.project === undefined ? outcome : backend.project(outcome, scope)),
      };
    };
    const reject = (access: ActiveAccess, back: Parsed<Key, Result>, message: string) => {
      deferPersistence('chatgpt-terminal-state', upstream.id, service.persistRejectedAccess(upstream, access, message), scope);
      if (!access.renewable) return finish(back);
      return refused({
        kind: 'error',
        source: 'upstream',
        status: 503,
        type: 'chatgpt_upstream_unavailable',
        error: new Error(`ChatGPT session terminated: ${message}`),
      });
    };
    const first = await dispatch(firstAccess);
    const firstOutcome = first[options.key];
    if (first['response.http'].status !== 401 || firstOutcome.kind !== 'error') return finish(first);
    const rejection = parseUpstreamError(firstOutcome.error);
    if (!firstAccess.renewable || rejection.code === 'token_invalidated') return reject(firstAccess, first, rejection.message);

    const refreshed = await getAccess(firstAccess.token.reveal());
    if (refreshed.kind === 'error') return refused(refreshed);
    const second = await dispatch(refreshed);
    const secondOutcome = second[options.key];
    if (second['response.http'].status !== 401 || secondOutcome.kind !== 'error') return finish(second);
    const finalRejection = parseUpstreamError(secondOutcome.error);
    return finalRejection.code === 'token_invalidated' ? reject(refreshed, second, finalRejection.message) : finish(second);
  },
});

// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/requests/headers.rs#L5-L12
// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/core/src/responses_metadata.rs#L255-L270
// https://github.com/openai/codex/blob/646f7c0a91b8e327d263335da68ae8ef212895ce/codex-rs/ext/image-generation/src/backend.rs#L81-L89
const passHeaders = new Set([
  'originator',
  'session-id',
  'session_id',
  'thread-id',
  'x-client-request-id',
  'x-codex-image-turn-id',
  'x-codex-turn-metadata',
  'x-codex-window-id',
  'authorization',
  'chatgpt-account-id',
  'user-agent',
  'version',
  'accept',
  'content-type',
  CHATGPT_RESPONSES_LITE_HEADER,
]);
const stripHeaders = stripHttpHeaders(name => passHeaders.has(name), 'chatgpt.strip-http-headers');

const observeQuota = (images: boolean) => defineStage<UpstreamInput, UpstreamInput, HttpOutput, HttpOutput, ChatGPTServices>({
  name: 'chatgpt.observe-quota',
  through: {
    request: { needs: ['provider.upstream'], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const upstream = facts['provider.upstream'];
    const { headers, status } = back['response.http'];
    const write = scope.services.chatgpt.observeQuota(upstream, plainHeaders(headers), status, images, new Date());
    if (write !== undefined) deferPersistence('chatgpt-quota', upstream.id, write, scope);
    return back;
  },
});

const normalizeResponsesMediaType = defineStage<ResponsesInput, ResponsesInput, HttpOutput, HttpOutput, ChatGPTServices>({
  name: 'chatgpt.responses.normalize-media-type',
  through: {
    request: { needs: ['request.action'], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http'] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const response = back['response.http'];
    if (facts['request.action'] === 'compact' || response.status < 200 || response.status >= 300
      || getHeader(response.headers, 'content-type') !== undefined) return back;
    // Codex can send SSE without a media type.
    // https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/endpoint/responses.rs
    return { ...back, 'response.http': { ...response, headers: setHeader(response.headers, 'content-type', 'text/event-stream') } };
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

const input = ['provider.upstream', 'provider.model', 'request.http', 'request.payload'] as const;
const output = ['response.http', 'response.modelKey'] as const;

const responses = compose<ResponsesInput & ProviderOpenAIResponsesOutput, ChatGPTServices>()('chatgpt.responses', {
  entry: [...input, 'request.action'],
  exit: [...output, 'response.openaiResponses'],
  stages: [
    injectDefaultInstructions,
    stripUnsupportedFields,
    backendStage<ResponsesInput, 'response.openaiResponses', Exclude<ResponsesOutcome, Failure>>({
      name: 'chatgpt.responses.authenticate-and-dispatch',
      key: 'response.openaiResponses',
      action: ['request.action'],
      operation: 'codex',
      prepare: (facts, access) => {
        const action = facts['request.action'];
        const prepared = prepareChatGPTResponsesRequest({
          model: facts['provider.model'],
          deviceId: access.deviceId,
          headers: plainHeaders(facts['request.http'].headers),
          body: facts['request.payload'],
        }, action);
        const headers = [
          ...codexHeaders(action === 'compact' ? 'application/json' : 'text/event-stream'),
          ...turnHeaders(prepared.identity, prepared.turnMetadataJson.header),
        ];
        if (prepared.responsesLite) headers.push([CHATGPT_RESPONSES_LITE_HEADER, 'true']);
        return {
          path: action === 'compact' ? CHATGPT_OPENAI_RESPONSES_COMPACT_PATH : CHATGPT_OPENAI_RESPONSES_PATH,
          headers,
          body: prepared.body,
          project: (outcome, scope) => {
            if (outcome.kind !== 'stream') return outcome;
            const { events } = outcome;
            const { movedFields } = prepared;
            const projected = Object.keys(movedFields).length === 0 ? events : scope.wrapStream(events, {
              label: 'chatgpt.responses.project-moved-fields',
              transform: source => projectMovedChatGPTResponsesFields(source, movedFields),
            });
            return {
              kind: 'stream', events: scope.wrapStream(projected, {
                label: 'chatgpt.responses.restore-output',
                transform: source => restoreChatGPTResponsesOutput(source),
              }),
            };
          },
        };
      },
    }),
    parseResponsesStage<ChatGPTUpstreamFacts, ChatGPTServices>(),
    normalizeResponsesMediaType,
    observeQuota(false),
    stripHeaders,
  ],
  ending: httpTerminal,
});

type UnaryOk = Extract<HttpOutcome, { kind: 'ok' }>;
type UnaryKey = 'response.alphaSearch' | 'response.openaiImagesGenerations' | 'response.openaiImagesEdits';
type UnarySpace<Payload> = ProviderInput<ChatGPTUpstreamFacts, Payload> & ProviderAlphaSearchOutput & ProviderOpenAIImagesGenerationsOutput & ProviderOpenAIImagesEditsOutput;

const unaryPipeline = <Payload, Key extends UnaryKey>(options: {
  readonly name: string;
  readonly key: Key;
  readonly operation: 'codex' | 'images';
  readonly prepare: (facts: ProviderInput<ChatGPTUpstreamFacts, Payload>) => BackendRequest<UnaryOk>;
}) => compose<UnarySpace<Payload>, ChatGPTServices>()(options.name, {
  entry: input,
  exit: [...output, options.key],
  stages: [
    backendStage({ ...options, action: [], name: `${options.name}.authenticate-and-dispatch` }),
    parseHttpOutcomeStage<Key, {}, ChatGPTServices>('parseHttpOutcome', options.key),
    observeQuota(options.operation === 'images'),
    stripHeaders,
  ],
  ending: httpTerminal,
});

const imagePipeline = <Payload, Key extends UnaryKey>(
  name: string,
  path: string,
  key: Key,
  buildBody: (body: Payload, modelKey: string) => Record<string, unknown>,
) => unaryPipeline<Payload, Key>({
  name,
  key,
  operation: 'images',
  prepare: facts => {
    const inbound = plainHeaders(facts['request.http'].headers);
    const headers: HeaderEntry[] = [
      ...codexHeaders('application/json', trimHeader(inbound, 'originator') ?? CHATGPT_ORIGINATOR),
      ['x-codex-image-turn-id', trimHeader(inbound, 'x-codex-image-turn-id') ?? uuidV7()],
    ];
    const metadata = trimHeader(inbound, 'x-codex-turn-metadata');
    if (metadata !== null) headers.push(['x-codex-turn-metadata', metadata]);
    return { path, headers, body: buildBody(facts['request.payload'], facts['provider.model'].id) };
  },
});

export const chatgptPipelines = {
  openaiResponses: responses,
  openaiImagesGenerations: imagePipeline<Omit<OpenAIImagesGenerationsPayload, 'model'>, 'response.openaiImagesGenerations'>(
    'chatgpt.images-generations', CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH, 'response.openaiImagesGenerations', (body, model) => ({ ...body, model }),
  ),
  openaiImagesEdits: imagePipeline<OpenAIImagesEditsRequest, 'response.openaiImagesEdits'>(
    'chatgpt.images-edits', CHATGPT_OPENAI_IMAGES_EDITS_PATH, 'response.openaiImagesEdits', serializeOpenAIImagesEditsJsonPayload,
  ),
  alphaSearch: unaryPipeline<Record<string, unknown>, 'response.alphaSearch'>({
    name: 'chatgpt.alpha-search',
    key: 'response.alphaSearch',
    operation: 'codex',
    prepare: facts => {
      const body = facts['request.payload'];
      const id = stringField(body, 'id') ?? uuidV7();
      const metadata = trimHeader(plainHeaders(facts['request.http'].headers), 'x-codex-turn-metadata');
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
} satisfies ProviderPipelines<ChatGPTUpstreamFacts, ChatGPTServices>;
