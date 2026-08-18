// The Anthropic Messages count-tokens chain, run. What is written down here is what only running it
// can say: that a measurement is taken on the body generation would have sent — the payload
// affinity materialized, the alias' own rules, the three request rules and the web-search
// rewrite — that a refusal is answered in the upstream's own words after every candidate has
// been tried, and that measuring bills nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { anthropicMessagesCountTokensPipeline } from '../../../src/data-plane/chat/anthropic-messages/count-tokens.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { move, run } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { AliasRules, ModelEndpoints } from '@floway-dev/protocols/common';
import { type FlagId, type AnthropicMessagesUpstreamCallOptions, type ModelCandidate, type ProviderCallResult } from '@floway-dev/provider';
import { stubInternalModel, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

vi.mock('../../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/data-plane/providers/resolution.ts')>()),
  enumerateModelCandidates: vi.fn(),
}));

let live: readonly ModelCandidate[] = [];

type CountTokens = (
  model: unknown,
  body: unknown,
  signal: AbortSignal | undefined,
  opts: AnthropicMessagesUpstreamCallOptions,
) => Promise<ProviderCallResult>;

const candidate = (
  callAnthropicMessagesCountTokens: CountTokens,
  overrides: {
    upstreamId?: string;
    endpoints?: ModelEndpoints;
    enabledFlags?: ReadonlySet<FlagId>;
    rules?: AliasRules;
  } = {},
): ModelCandidate => {
  const upstreamId = overrides.upstreamId ?? 'up_a';
  const endpoints = overrides.endpoints ?? { anthropicMessages: {} };
  const enabledFlags = overrides.enabledFlags ?? new Set<FlagId>();
  return {
    provider: {
      upstreamId, kind: 'claude-code', name: upstreamId,
      // Wide enough that a header reaching the provider proves the ending let it through,
      // rather than proving only that the allowlist did.
      inboundHeaderAllowlist: [/^(anthropic-beta|x-trace)$/],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider({ callAnthropicMessagesCountTokens: callAnthropicMessagesCountTokens as never }),
    },
    model: stubInternalModel(
      {
        id: 'claude-model',
        endpoints,
        providerModels: { [upstreamId]: stubProviderModel({ id: 'claude-model', endpoints, enabledFlags }) },
      },
      upstreamId,
    ),
    ...(overrides.rules === undefined ? {} : { rules: overrides.rules }),
  } as unknown as ModelCandidate;
};

const resolves = (candidates: readonly ModelCandidate[], sawModel = true): void => {
  live = candidates;
  vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates, sawModel, failedUpstreams: [] } as never);
};

const counted = (input: number): ProviderCallResult => ({
  response: Response.json({ input_tokens: input }),
  modelKey: 'claude-model-key',
});

const payload = { model: 'claude-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] } as unknown as AnthropicMessagesPayload;

/** What affinity materialized for the candidate about to be dialled. It differs from the
 *  payload the client sent, which is the point: carried state is rewritten per candidate. */
let affinityPayload: AnthropicMessagesPayload = payload;

const count = async (
  request: AnthropicMessagesPayload = payload,
  headers: readonly (readonly [string, string])[] = [],
) => {
  const gateway = mockChatGatewayCtx({ wantsStream: false });
  return await run(
    anthropicMessagesCountTokensPipeline(request),
    move({
      'ingress.http.headers': headers,
      'ingress.chat.sourceProtocol': 'anthropicMessages',
      'request.chat.anthropicMessages': request,
      'serve.model': request.model,
    }) as never,
    {
      gateway,
      background: () => {},
      rememberCandidates: () => {},
      rememberChatSelection: () => {},
      chatPayloadFor: () => affinityPayload,
      selectAffinity: () => { throw new Error('a measurement pins nothing; it must not select affinity'); },
      resolveAttempt: (selector: { readonly upstreamId: string }) => {
        const found = live.find(c => c.provider.upstreamId === selector.upstreamId);
        if (found === undefined) throw new Error(`no live candidate for ${selector.upstreamId}`);
        return found;
      },
    } as never,
  );
};

beforeEach(() => {
  vi.mocked(enumerateModelCandidates).mockReset();
  affinityPayload = payload;
  initRepo({
    usage: { record: async () => {} },
    performance: { recordNeutral: async () => {}, recordZeroOutputError: async () => {} },
  } as never);
});

describe('the messages count-tokens chain', () => {
  // The same statement the generate chain makes: what is measured is the body affinity
  // materialized for this candidate, stamped with the id that candidate actually serves,
  // with an alias' own rules overlaid on top of it.
  it('measures the payload this attempt is owed, under the id the upstream resolved', async () => {
    let sent: Record<string, unknown> | undefined;
    let seenModel: { readonly id: string } | undefined;
    affinityPayload = { ...payload, messages: [{ role: 'user', content: 'rewritten' }] } as AnthropicMessagesPayload;
    resolves([candidate(async (model, body) => {
      seenModel = model as { readonly id: string };
      sent = body as Record<string, unknown>;
      return counted(11);
    }, { rules: { reasoning: { effort: 'high' } } })]);

    const { facts } = await count();

    expect(facts['response.http.status']).toBe(200);
    expect(facts['response.chat.anthropicMessages.rendered']).toEqual({ input_tokens: 11 });
    expect(seenModel?.id).toBe('claude-model');
    expect(sent).toMatchObject({ messages: [{ role: 'user', content: 'rewritten' }] });
    // The id the client addressed does not travel: the provider re-stamps what it resolved.
    expect(sent).not.toHaveProperty('model');
    // An alias' rules reach the measured body, so a count and the generation it precedes
    // are taken on the same request.
    expect(sent).toMatchObject({ output_config: { effort: 'high' } });
  });

  // Counting observes the same gateway-level rewrites generation does, in the order the
  // chain applies them, so a client is told what the request it is about to send costs.
  it('applies the three request rules generation applies', async () => {
    let sent: Record<string, unknown> | undefined;
    affinityPayload = {
      ...payload,
      system: 'x-anthropic-billing-header: token\ncch=deadbeef1234;\nbase rules',
      messages: [
        { role: 'system', content: 'inline rules' },
        { role: 'user', content: 'hello' },
      ],
      thinking: { type: 'enabled', budget_tokens: 1024 },
      output_config: { effort: 'high' },
      tool_choice: { type: 'tool', name: 'lookup' },
    } as unknown as AnthropicMessagesPayload;
    resolves([candidate(async (_model, body) => { sent = body as Record<string, unknown>; return counted(9); }, {
      enabledFlags: new Set<FlagId>([
        'strip-billing-attribution',
        'disable-reasoning-on-forced-tool-choice',
        'rewrite-mid-conv-system-to-user',
      ]),
    })]);

    await count();

    expect(sent).toEqual({
      max_tokens: 64,
      system: 'base rules',
      messages: [
        { role: 'user', content: 'inline rules' },
        { role: 'user', content: 'hello' },
      ],
      thinking: { type: 'disabled' },
      tool_choice: { type: 'tool', name: 'lookup' },
    });
  });

  // Anthropic's native server tool never reaches an upstream as itself — the shim sends an
  // ordinary client tool — so a count taken on the client's own body would measure a request
  // nobody is sent.
  it('measures the client-tool shape the web-search shim would actually send', async () => {
    let sent: AnthropicMessagesPayload | undefined;
    const asked = { ...payload, tools: [{ type: 'web_search_20260209', max_uses: 3 }] } as unknown as AnthropicMessagesPayload;
    affinityPayload = asked;
    resolves([candidate(async (_model, body) => { sent = body as AnthropicMessagesPayload; return counted(13); }, {
      enabledFlags: new Set<FlagId>(['messages-web-search-shim']),
    })]);

    await count(asked);

    const tool = sent?.tools?.[0] as { name?: string; type?: string; input_schema?: unknown } | undefined;
    expect(tool?.name).toBe('web_search');
    expect(tool).not.toHaveProperty('type');
    expect(tool?.input_schema).toEqual({
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    });
  });

  // A tool definition this protocol rejects is an answer the chain already holds, so no
  // upstream is asked what an unsendable request would cost.
  it('refuses a native web-search definition the protocol rejects without dialling', async () => {
    const asked = {
      ...payload,
      tools: [
        { type: 'web_search_20260209' },
        { type: 'web_search_20250305' },
      ],
    } as unknown as AnthropicMessagesPayload;
    affinityPayload = asked;
    let dialled = 0;
    resolves([candidate(async () => { dialled += 1; return counted(0); }, {
      enabledFlags: new Set<FlagId>(['messages-web-search-shim']),
    })]);

    const { facts } = await count(asked);

    expect(dialled).toBe(0);
    expect(facts['response.http.status']).toBe(400);
    expect(facts['response.chat.anthropicMessages.rendered']).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Only one native web search tool definition is supported per request.' },
    });
  });

  // The flag is the whole of the gate here: counting has only the native wire, so the
  // structural half of the shim's condition — a translated target — can never hold.
  it('leaves the native tool alone on a candidate the shim is off for', async () => {
    let sent: AnthropicMessagesPayload | undefined;
    const asked = { ...payload, tools: [{ type: 'web_search_20260209', max_uses: 3 }] } as unknown as AnthropicMessagesPayload;
    affinityPayload = asked;
    resolves([candidate(async (_model, body) => { sent = body as AnthropicMessagesPayload; return counted(13); })]);

    await count(asked);

    expect(sent?.tools).toEqual([{ type: 'web_search_20260209', max_uses: 3 }]);
  });

  // Anthropic beta flags have a typed path of their own precisely so no provider's header
  // allowlist can admit them, and a measurement asks the same question generation does.
  it('hands the beta flags over on their own path and not as a header', async () => {
    let seen: AnthropicMessagesUpstreamCallOptions | undefined;
    resolves([candidate(async (_model, _body, _signal, opts) => { seen = opts; return counted(5); })]);

    await count(payload, [
      ['anthropic-beta', 'context-1m-2025-08-07, advanced-tool-use-2025-11-20'],
      ['x-trace', 'abc'],
    ]);

    expect(seen?.anthropicBeta).toEqual(['context-1m-2025-08-07', 'advanced-tool-use-2025-11-20']);
    expect(seen?.headers.get('anthropic-beta')).toBeNull();
    expect(seen?.headers.get('x-trace')).toBe('abc');
  });

  // A measurement one upstream refused is a measurement another may answer, which is what
  // the fork is for — and the surviving refusal keeps the upstream's own status and words.
  it('fails a refused measurement over to the next candidate', async () => {
    const tried: string[] = [];
    resolves([
      candidate(async () => {
        tried.push('busy');
        return { response: new Response('unavailable', { status: 503 }), modelKey: 'k' };
      }, { upstreamId: 'up_busy' }),
      candidate(async () => { tried.push('free'); return counted(42); }, { upstreamId: 'up_free' }),
    ]);

    const { facts } = await count();

    expect(tried).toEqual(['busy', 'free']);
    expect(facts['response.http.status']).toBe(200);
    expect(facts['response.chat.anthropicMessages.rendered']).toEqual({ input_tokens: 42 });
  });

  it('answers the last refusal in the upstream-s own status and words', async () => {
    resolves([candidate(async () => ({
      response: new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
        status: 429, headers: { 'content-type': 'application/json' },
      }),
      modelKey: 'k',
    }))]);

    const { facts } = await count();

    expect(facts['response.http.status']).toBe(429);
    expect(facts['response.chat.anthropicMessages.rendered']).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    });
  });

  // A refused connection is an outcome the fork has to be able to see, not a fault that ends
  // the run.
  it('fails a dial that never connected over to the next candidate', async () => {
    const tried: string[] = [];
    resolves([
      candidate(async () => { tried.push('dead'); throw new Error('ECONNREFUSED'); }, { upstreamId: 'up_dead' }),
      candidate(async () => { tried.push('alive'); return counted(7); }, { upstreamId: 'up_alive' }),
    ]);

    const { facts } = await count();

    expect(tried).toEqual(['dead', 'alive']);
    expect(facts['response.chat.anthropicMessages.rendered']).toEqual({ input_tokens: 7 });
  });

  // Only a native Anthropic Messages endpoint measures — no translation carries the question — so a
  // candidate that would serve generation over a translated wire cannot serve this, and the
  // refusal names the endpoint the client actually addressed.
  it('refuses a candidate no wire can measure on, naming the count endpoint', async () => {
    resolves([candidate(async () => counted(0), { endpoints: { openaiChatCompletions: {} } })]);

    const { facts } = await count();

    expect(facts['response.http.status']).toBe(400);
    expect(facts['response.chat.anthropicMessages.rendered']).toMatchObject({
      error: {
        type: 'invalid_request_error',
        message: 'Model claude-model does not support the /messages/count_tokens endpoint.',
      },
    });
  });

  // Measuring is not generating: no upstream charged for the answer, so the run has nothing
  // to bill and says so rather than naming an entity that reported zero.
  it('bills nothing for a measurement', async () => {
    resolves([candidate(async () => counted(3))]);

    const { facts } = await count();

    expect((facts as Record<string, unknown>)['response.usage.billable']).toEqual([]);
  });
});
