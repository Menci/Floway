import { app } from './app.ts';
import { clearModelsStore } from './data-plane/providers/models-store.ts';
import type { ModelProvider, UpstreamModel } from './data-plane/providers/types.ts';
import type { SearchConfig } from './data-plane/tools/web-search/types.ts';
import { initRepo } from './repo/index.ts';
import { InMemoryRepo } from './repo/memory.ts';
import type { ApiKey, TelemetryModelIdentity, UpstreamRecord } from './repo/types.ts';
import { initEnv } from './runtime/env.ts';
import { clearCopilotTokenCache } from './shared/copilot.ts';
import type { Upstream } from './shared/upstream/types.ts';

interface SetupOptions {
  adminKey?: string;
  apiKey?: ApiKey;
  githubAccount?: CopilotAccountFixture;
  copilotUpstream?: UpstreamRecord;
  searchConfig?: SearchConfig;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface AppTestContext {
  repo: InMemoryRepo;
  adminKey: string;
  apiKey: ApiKey;
  githubAccount: CopilotAccountFixture;
  copilotUpstream: UpstreamRecord;
}

interface CopilotAccountFixture {
  token: string;
  accountType: string;
  user: {
    login: string;
    avatar_url: string;
    name: string | null;
    id: number;
  };
}

interface SSEChunk {
  event?: string;
  data: string | Record<string, unknown>;
}

let fetchLock: Promise<void> = Promise.resolve();

const TEST_UPSTREAM_TIMESTAMP = '2026-03-15T00:00:00.000Z';

export const buildCopilotUpstreamRecord = (githubAccount: CopilotAccountFixture, overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const config = {
    githubToken: githubAccount.token,
    accountType: githubAccount.accountType,
    user: githubAccount.user,
  };
  const { config: overrideConfig, ...rest } = overrides;

  return {
    id: 'up_copilot',
    provider: 'copilot',
    name: githubAccount.user.login ? `GitHub Copilot (${githubAccount.user.login})` : 'GitHub Copilot',
    enabled: true,
    sortOrder: 0,
    createdAt: TEST_UPSTREAM_TIMESTAMP,
    updatedAt: TEST_UPSTREAM_TIMESTAMP,
    flagOverrides: {},
    ...rest,
    config: overrideConfig ?? config,
  };
};

export const buildCustomUpstreamRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const config = {
    baseUrl: 'https://custom.example.com',
    bearerToken: 'sk-custom',
    supportedEndpoints: ['/chat/completions'],
  };
  const { config: overrideConfig, ...rest } = overrides;

  return {
    id: 'up_custom',
    provider: 'custom',
    name: 'Custom Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: TEST_UPSTREAM_TIMESTAMP,
    updatedAt: TEST_UPSTREAM_TIMESTAMP,
    flagOverrides: {},
    ...rest,
    config: overrideConfig ?? config,
  };
};

export async function setupAppTest(options: SetupOptions = {}): Promise<AppTestContext> {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const adminKey = options.adminKey ?? 'admin-test-key';
  initEnv(name => (name === 'ADMIN_KEY' ? adminKey : ''));

  await clearCopilotTokenCache();
  clearModelsStore();

  const apiKey = options.apiKey ?? {
    id: `key_${crypto.randomUUID()}`,
    name: 'Primary key',
    key: `raw_${crypto.randomUUID().replace(/-/g, '')}`,
    createdAt: '2026-03-15T00:00:00.000Z',
    upstreamIds: null,
  };
  await repo.apiKeys.save(apiKey);

  const githubAccount = options.githubAccount ?? {
    token: `ghu_${crypto.randomUUID().replace(/-/g, '')}`,
    accountType: 'individual',
    user: {
      id: Math.floor(Math.random() * 1000000) + 1,
      login: 'tester',
      name: 'Test User',
      avatar_url: 'https://example.com/avatar.png',
    },
  };
  const copilotUpstream = options.copilotUpstream ?? buildCopilotUpstreamRecord(githubAccount);
  await repo.upstreams.save(copilotUpstream);

  if (options.searchConfig !== undefined) {
    await repo.searchConfig.save(options.searchConfig);
  }

  return { repo, adminKey, apiKey, githubAccount, copilotUpstream };
}

export async function withMockedFetch<T>(handler: (request: Request) => Promise<Response> | Response, run: () => Promise<T>): Promise<T> {
  let release: (() => void) | undefined;
  const previousLock = fetchLock;
  fetchLock = new Promise<void>(resolve => {
    release = resolve;
  });
  await previousLock;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: FetchInput, init?: FetchInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    return Promise.resolve(handler(request));
  };

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    release?.();
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function sseResponse(chunks: SSEChunk[], status = 200): Response {
  const text = `${chunks
    .map(chunk => {
      const lines: string[] = [];
      if (chunk.event) lines.push(`event: ${chunk.event}`);
      const data = typeof chunk.data === 'string' ? chunk.data : JSON.stringify(chunk.data);
      lines.push(`data: ${data}`);
      return lines.join('\n');
    })
    .join('\n\n')}\n\n`;

  return new Response(text, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// Reusable SSE wrappers for upstream test mocks. Provider layer now forces
// stream=true on every LLM endpoint, so upstreams must reply with SSE — these
// helpers project a single non-stream JSON shape into the canonical SSE chunks
// that mirror what a real streaming upstream would emit.

export function sseMessagesResponse(response: Record<string, unknown>): Response {
  const chunks: SSEChunk[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: response.id,
          type: response.type ?? 'message',
          role: response.role ?? 'assistant',
          content: [],
          model: response.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { ...(response.usage as Record<string, unknown>), output_tokens: 0 },
        },
      },
    },
  ];

  const blocks = (response.content as Array<Record<string, unknown>>) ?? [];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      chunks.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
      if (block.text) {
        chunks.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } } });
      }
      chunks.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    }
  });

  chunks.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: response.stop_reason ?? 'end_turn', stop_sequence: response.stop_sequence ?? null },
      usage: { output_tokens: ((response.usage as Record<string, unknown>)?.output_tokens as number) ?? 0 },
    },
  });
  chunks.push({ event: 'message_stop', data: { type: 'message_stop' } });

  return sseResponse(chunks);
}

export function sseChatCompletionsResponse(response: Record<string, unknown>): Response {
  const choice = ((response.choices as Array<Record<string, unknown>>) ?? [{}])[0] ?? {};
  const message = (choice.message as Record<string, unknown>) ?? {};
  const id = (response.id as string) ?? 'chatcmpl_test';
  const model = (response.model as string) ?? 'test-model';
  const created = (response.created as number) ?? 0;
  const finishReason = (choice.finish_reason as string) ?? 'stop';

  const baseChunk = (delta: Record<string, unknown>, withFinishReason = false) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: withFinishReason ? finishReason : null }],
  });

  const chunks: SSEChunk[] = [{ data: baseChunk({ role: message.role ?? 'assistant' }) }];
  if (message.content) {
    chunks.push({ data: baseChunk({ content: message.content }) });
  }
  chunks.push({ data: baseChunk({}, true) });
  if (response.usage) {
    chunks.push({ data: { id, object: 'chat.completion.chunk', created, model, choices: [], usage: response.usage } });
  }
  chunks.push({ data: '[DONE]' });

  return sseResponse(chunks);
}

export function sseResponsesResponse(response: Record<string, unknown>): Response {
  // The target boundary expands fast-path (created+in_progress+terminal) into
  // a full sequence, so emitting only those wrapper events here is sufficient
  // and exercises the production expansion path.
  return sseResponse([
    { event: 'response.created', data: { type: 'response.created', response: { ...response, status: 'in_progress', output: [], output_text: '' }, sequence_number: 0 } },
    { event: 'response.in_progress', data: { type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [], output_text: '' }, sequence_number: 1 } },
    { event: 'response.completed', data: { type: 'response.completed', response, sequence_number: 2 } },
    { data: '[DONE]' },
  ]);
}

export async function requestApp(path: string, init: RequestInit): Promise<Response> {
  return await app.request(path, init);
}

export function parseSSEText(text: string): Array<{ event: string; data: string }> {
  const blocks = text
    .split('\n\n')
    .map(block => block.trim())
    .filter(Boolean);
  return blocks.map(block => {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    return { event, data };
  });
}

export async function flushAsyncWork(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

export function copilotModels(
  models: Array<{
    id: string;
    display_name?: string;
    supported_endpoints?: string[];
    reasoningEfforts?: string[];
    maxContextWindowTokens?: number;
    maxPromptTokens?: number;
    maxOutputTokens?: number;
  }>,
) {
  return {
    object: 'list',
    data: models.map(model => ({
      id: model.id,
      name: model.id,
      ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
      version: '1',
      supported_endpoints: model.supported_endpoints ?? [],
      capabilities: {
        type: 'chat',
        limits: {
          ...(model.maxContextWindowTokens !== undefined ? { max_context_window_tokens: model.maxContextWindowTokens } : {}),
          ...(model.maxPromptTokens !== undefined ? { max_prompt_tokens: model.maxPromptTokens } : {}),
          ...(model.maxOutputTokens !== undefined ? { max_output_tokens: model.maxOutputTokens } : {}),
        },
        ...(model.reasoningEfforts !== undefined ? { supports: { reasoning_effort: model.reasoningEfforts } } : {}),
      },
    })),
  };
}

// A throwaway upstream stub for unit tests that exercise the low-level upstream
// adapter cache without depending on a real network target.
export const stubUpstream = (overrides: Partial<Upstream> = {}): Upstream => ({
  id: 'test-upstream',
  name: 'Test Upstream',
  kind: 'custom',
  supportedEndpoints: ['/chat/completions', '/responses', '/v1/messages'],
  fetch: () => Promise.reject(new Error('stubUpstream.fetch was called')),
  ...overrides,
});

export const stubUpstreamModel = (overrides: Partial<UpstreamModel> = {}): UpstreamModel => ({
  id: 'test-model',
  limits: {},
  kind: 'chat',
  upstreamEndpoints: ['chat_completions', 'responses', 'messages'],
  enabledFlags: new Set<string>(),
  ...overrides,
});

export const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key', cost: null,
};

export const stubProvider = (overrides: Partial<ModelProvider> = {}): ModelProvider => ({
  getProvidedModels: () => Promise.resolve([]),
  getPricingForModelKey: () => null,
  callChatCompletions: () => Promise.reject(new Error('stubProvider.callChatCompletions was called')),
  callResponses: () => Promise.reject(new Error('stubProvider.callResponses was called')),
  callMessages: () => Promise.reject(new Error('stubProvider.callMessages was called')),
  callMessagesCountTokens: () => Promise.reject(new Error('stubProvider.callMessagesCountTokens was called')),
  callEmbeddings: () => Promise.reject(new Error('stubProvider.callEmbeddings was called')),
  callImagesGenerations: () => Promise.reject(new Error('stubProvider.callImagesGenerations was called')),
  callImagesEdits: () => Promise.reject(new Error('stubProvider.callImagesEdits was called')),
  ...overrides,
});
