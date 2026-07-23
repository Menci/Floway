import { app } from './app.ts';
import { clearInFlightForTesting } from './data-plane/providers/models-cache.ts';
import type { SearchConfig } from './data-plane/tools/web-search/types.ts';
import { initRepo } from './repo/index.ts';
import { InMemoryRepo } from './repo/memory.ts';
import type { ApiKey } from './repo/types.ts';
import { initBackgroundSchedulerResolver } from './runtime/background.ts';
import { trackBackground } from './test-helpers/background-tracker.ts';
import { createInMemoryImageProcessor, initEnv, initExternalResourceFetcher, initFileProvider, initImageProcessor, MemoryFileProvider } from '@floway-dev/platform';
import type { UpstreamRecord } from '@floway-dev/provider';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';

interface SetupOptions {
  // `null` models an unset ADMIN_KEY — the platform EnvGetter contract says
  // missing vars surface as `undefined`, which is what a fresh Node dev
  // checkout hits (`process.env.ADMIN_KEY` is unset). The `?? ''` default and
  // the raw `string` type below cannot express that state, so tests targeting
  // the "no ADMIN_KEY at all" path need this explicit third value.
  adminKey?: string | null;
  apiKey?: ApiKey;
  githubAccount?: CopilotAccountFixture;
  copilotUpstream?: UpstreamRecord;
  searchConfig?: SearchConfig;
}

interface AppTestContext {
  repo: InMemoryRepo;
  adminKey: string;
  adminSession: string;
  apiKey: ApiKey;
  githubAccount: CopilotAccountFixture;
  copilotUpstream: UpstreamRecord;
}

interface CopilotAccountFixture {
  token: string;
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

const TEST_UPSTREAM_TIMESTAMP = '2026-03-15T00:00:00.000Z';

export const buildCopilotUpstreamRecord = (githubAccount: CopilotAccountFixture, overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const config = {
    githubToken: githubAccount.token,
    user: githubAccount.user,
  };
  const { config: overrideConfig, ...rest } = overrides;

  return {
    id: 'up_copilot',
    kind: 'copilot',
    name: githubAccount.user.login ? `GitHub Copilot (${githubAccount.user.login})` : 'GitHub Copilot',
    enabled: true,
    sortOrder: 0,
    createdAt: TEST_UPSTREAM_TIMESTAMP,
    updatedAt: TEST_UPSTREAM_TIMESTAMP,
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    color: null,
    ...rest,
    config: overrideConfig ?? config,
  };
};

export const buildCustomUpstreamRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const config = {
    baseUrl: 'https://custom.example.com',
    authStyle: 'bearer',
    apiKey: 'sk-custom',
    endpoints: { chatCompletions: {} },
  };
  const { config: overrideConfig, ...rest } = overrides;

  return {
    id: 'up_custom',
    kind: 'custom',
    name: 'Custom Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: TEST_UPSTREAM_TIMESTAMP,
    updatedAt: TEST_UPSTREAM_TIMESTAMP,
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    color: null,
    ...rest,
    config: overrideConfig ?? config,
  };
};

export async function setupAppTest(options: SetupOptions = {}): Promise<AppTestContext> {
  const repo = new InMemoryRepo();
  initRepo(repo);
  initExternalResourceFetcher(() => Promise.resolve(new Response(null, { status: 404 })));
  initFileProvider(new MemoryFileProvider());
  initImageProcessor(createInMemoryImageProcessor());
  // Route background promises through the shared tracker so flushBackground()
  // can deterministically await them — see test-helpers/background-tracker.ts.
  initBackgroundSchedulerResolver(_c => trackBackground);

  const adminKey = 'adminKey' in options ? options.adminKey : 'admin-test-key';
  initEnv(name => {
    if (name !== 'ADMIN_KEY') return '';
    return adminKey === null ? undefined : adminKey;
  });

  clearInProcessCopilotTokenCache();
  clearInFlightForTesting();

  // The default API key is owned by a non-admin user so tests can assert
  // "non-admin via API key" behavior straight away. Tests that need an
  // admin caller use `adminSession` (sessions belong to user 1).
  await repo.users.save({
    id: 2,
    username: 'tester',
    passwordHash: null,
    isAdmin: false,
    upstreamIds: null,
    canViewGlobalTelemetry: false,
    createdAt: '2026-03-15T00:00:00.000Z',
    deletedAt: null,
  });

  const apiKey = options.apiKey ?? {
    id: `key_${crypto.randomUUID()}`,
    userId: 2,
    name: 'Primary key',
    key: `raw_${crypto.randomUUID().replace(/-/g, '')}`,
    serverSecret: '00'.repeat(32),
    createdAt: '2026-03-15T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
  };
  await repo.apiKeys.save(apiKey);

  const githubAccount = options.githubAccount ?? {
    token: `ghu_${crypto.randomUUID().replace(/-/g, '')}`,
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

  // Most tests need an admin-authenticated dashboard caller; expose a fresh
  // session token tied to user 1 (the seed admin) for
  // `x-floway-session: adminSession`.
  const adminSession = (await repo.sessions.create(1)).id;

  return { repo, adminKey: adminKey ?? '', adminSession, apiKey, githubAccount, copilotUpstream };
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

// Reusable SSE wrappers for upstream test mocks. The provider layer forces
// stream=true on every chat endpoint, so upstreams must reply with SSE — these
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

  const blocks = response.content as Array<Record<string, unknown>>;
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
      usage: { output_tokens: (response.usage as Record<string, unknown>).output_tokens as number },
    },
  });
  chunks.push({ event: 'message_stop', data: { type: 'message_stop' } });

  return sseResponse(chunks);
}

export function sseChatCompletionsResponse(response: Record<string, unknown>): Response {
  const choice = (response.choices as Array<Record<string, unknown>>)[0];
  const message = choice.message as Record<string, unknown>;
  const id = response.id as string;
  const model = response.model as string;
  const created = response.created as number;
  const finishReason = choice.finish_reason as string;

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
  // The Responses stream wrapper expands a created+in_progress+completed
  // triplet into the full event sequence, so emitting just those three
  // wrapper events here exercises that expansion path.
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
