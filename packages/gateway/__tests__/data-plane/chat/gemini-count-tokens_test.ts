// The Gemini count-tokens chain, run. What is written down here is what only running it can
// say: that the question is asked in Messages and the answer read back out as Google's, that
// what no translation can carry is gone before the question is asked, that a refusal keeps
// the upstream's own status, and that measuring bills nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { geminiGenerateContentCountTokensPipeline } from '../../../src/data-plane/chat/gemini-generate-content/count-tokens.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { move, run } from '@floway-dev/pipeline';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { AnthropicMessagesUpstreamCallOptions, ModelCandidate, ProviderCallResult } from '@floway-dev/provider';
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
  callMessagesCountTokens: CountTokens,
  overrides: { upstreamId?: string; endpoints?: ModelEndpoints } = {},
): ModelCandidate => {
  const upstreamId = overrides.upstreamId ?? 'up_a';
  const endpoints = overrides.endpoints ?? { messages: {} };
  return {
    provider: {
      upstreamId, kind: 'claude-code', name: upstreamId,
      // Wide enough that a header reaching the provider proves the ending let it through,
      // rather than proving only that the allowlist did.
      inboundHeaderAllowlist: [/^(anthropic-beta|x-trace)$/],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider({ callMessagesCountTokens: callMessagesCountTokens as never }),
    },
    model: stubInternalModel(
      {
        id: 'claude-model',
        endpoints,
        limits: { max_output_tokens: 4096 },
        providerModels: { [upstreamId]: stubProviderModel({ id: 'claude-model', endpoints }) },
      },
      upstreamId,
    ),
  } as unknown as ModelCandidate;
};

const resolves = (candidates: readonly ModelCandidate[]): void => {
  live = candidates;
  vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates, sawModel: true, failedUpstreams: [] } as never);
};

const answered = (body: unknown): ProviderCallResult => ({
  response: Response.json(body),
  modelKey: 'claude-model-key',
});

const payload: GeminiGenerateContentPayload = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

const count = async (
  request: GeminiGenerateContentPayload = payload,
  headers: readonly (readonly [string, string])[] = [],
) => {
  const gateway = mockChatGatewayCtx({ wantsStream: false });
  return await run(
    geminiGenerateContentCountTokensPipeline(request),
    move({
      'ingress.http.headers': headers,
      'ingress.chat.sourceProtocol': 'gemini',
      'request.chat.geminiGenerateContent': request,
      'serve.model': 'gemini-model',
    }) as never,
    {
      gateway,
      background: () => {},
      rememberCandidates: () => {},
      rememberChatSelection: () => {},
      chatPayloadFor: () => request,
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
  initRepo({
    usage: { record: async () => {} },
    performance: { recordNeutral: async () => {}, recordZeroOutputError: async () => {} },
  } as never);
});

describe('the gemini count-tokens chain', () => {
  // Gemini has no endpoint that answers this, so the question is asked in Messages and the
  // counts are read back out under the name this protocol gives them.
  it('asks the question in Messages and answers in Google-s own envelope', async () => {
    let sent: AnthropicMessagesPayload | undefined;
    let seenModel: { readonly id: string } | undefined;
    resolves([candidate(async (model, body) => {
      seenModel = model as { readonly id: string };
      sent = body as AnthropicMessagesPayload;
      return answered({ input_tokens: 42 });
    })]);

    const { facts } = await count({ ...payload, systemInstruction: { parts: [{ text: 'system' }] } });

    expect(facts['response.http.status']).toBe(200);
    expect(facts['response.chat.geminiGenerateContent.rendered']).toEqual({ totalTokens: 42 });
    expect(seenModel?.id).toBe('claude-model');
    expect(sent?.system).toBeDefined();
    expect(sent?.messages).toMatchObject([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    // `stream` says how an answer would be delivered, and a measurement delivers none.
    expect(sent).not.toHaveProperty('stream');
  });

  // Anthropic's own endpoint answers `input_tokens`; a Copilot upstream's translated count
  // answers `total_tokens`. Either is the number this protocol calls `totalTokens`.
  it('reads the other dialect an upstream states its counts in', async () => {
    resolves([candidate(async () => answered({ total_tokens: 19 }))]);

    const { facts } = await count();

    expect(facts['response.chat.geminiGenerateContent.rendered']).toEqual({ totalTokens: 19 });
  });

  // A body carrying neither figure is an answer this gateway cannot read, which is the
  // gateway failing to serve — and it is a failure the fork can move past, so another
  // upstream gets asked before the client is told.
  it('fails an unreadable count over, then reports it as the gateway-s own', async () => {
    const tried: string[] = [];
    resolves([
      candidate(async () => { tried.push('odd'); return answered({ unexpected: true }); }, { upstreamId: 'up_odd' }),
      candidate(async () => { tried.push('odder'); return answered({ unexpected: true }); }, { upstreamId: 'up_odder' }),
    ]);

    const { facts } = await count();

    expect(tried).toEqual(['odd', 'odder']);
    expect(facts['response.http.status']).toBe(502);
    expect(facts['response.chat.geminiGenerateContent.rendered']).toEqual({
      error: { code: 502, message: 'Invalid upstream token counting response.', status: 'UNAVAILABLE' },
    });
  });

  // Gemini has no wire of its own, so what no translation can carry cannot be sent whichever
  // candidate answers — and a count taken before the strip would measure a request the
  // translator would refuse.
  it('strips what no translation carries before asking', async () => {
    let sent: AnthropicMessagesPayload | undefined;
    resolves([candidate(async (_model, body) => { sent = body as AnthropicMessagesPayload; return answered({ input_tokens: 5 }); })]);

    const { facts } = await count({
      contents: [{ role: 'user', parts: [{ text: 'hi' }, { fileData: { fileUri: 'gs://x', mimeType: 'text/plain' } }] }],
      tools: [{ googleSearch: {} }],
      safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
    } as unknown as GeminiGenerateContentPayload);

    expect(facts['response.chat.geminiGenerateContent.rendered']).toEqual({ totalTokens: 5 });
    // A tool group left declaring no function is not a tool group, so `tools` goes with it.
    expect(sent).not.toHaveProperty('tools');
    expect(JSON.stringify(sent)).not.toContain('fileData');
    expect(sent).not.toHaveProperty('safetySettings');
  });

  // Anthropic's beta flags are the client's own only when the client spoke that protocol, and
  // a Gemini turn asked for nothing on that wire.
  it('does not carry another protocol-s beta flags across the boundary', async () => {
    let seen: AnthropicMessagesUpstreamCallOptions | undefined;
    resolves([candidate(async (_model, _body, _signal, opts) => { seen = opts; return answered({ input_tokens: 1 }); })]);

    await count(payload, [['anthropic-beta', 'must-not-cross-source-protocols'], ['x-trace', 'abc']]);

    expect(seen?.anthropicBeta).toEqual([]);
    expect(seen?.headers.get('anthropic-beta')).toBeNull();
    expect(seen?.headers.get('x-trace')).toBe('abc');
  });

  it('keeps the status of an upstream that refused, and names a refusal that said nothing', async () => {
    resolves([candidate(async () => ({ response: new Response('', { status: 503 }), modelKey: 'k' }))]);

    const { facts } = await count();

    expect(facts['response.http.status']).toBe(503);
    expect(facts['response.chat.geminiGenerateContent.rendered']).toEqual({
      error: { code: 503, message: 'Upstream token counting request failed.', status: 'UNAVAILABLE' },
    });
  });

  // Only an upstream's own Messages endpoint measures, so a candidate that would serve
  // generation over a translated wire cannot serve this.
  it('refuses a candidate no wire can measure on, naming the action', async () => {
    resolves([candidate(async () => answered({ input_tokens: 0 }), { endpoints: { chatCompletions: {} } })]);

    const { facts } = await count();

    expect(facts['response.http.status']).toBe(400);
    expect(facts['response.chat.geminiGenerateContent.rendered']).toEqual({
      error: { code: 400, message: 'Model gemini-model does not support countTokens.', status: 'INVALID_ARGUMENT' },
    });
  });

  it('bills nothing for a measurement', async () => {
    resolves([candidate(async () => answered({ input_tokens: 3 }))]);

    const { facts } = await count();

    expect((facts as Record<string, unknown>)['response.usage.billable']).toEqual([]);
  });
});
