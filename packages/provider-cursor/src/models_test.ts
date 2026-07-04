import { describe, expect, test } from 'vitest';

import {
  buildCollapsedCatalog,
  cursorRawToProviderModel,
  cursorWireModelId,
  fetchCursorBaseModels,
  fetchCursorCatalog,
  parseContextWindow,
  resolveCursorWireModel,
  type CursorBaseModel,
  type CursorRawModel,
} from './models.ts';
import { type Fetcher, type ProviderModel } from '@floway-dev/provider';

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const noopHeaders: Record<string, string> = {};
const fetcherOf = (resp: () => Response | Promise<Response>): Fetcher =>
  (async () => await resp()) as unknown as Fetcher;

const routingFetcher = (routes: {
  usable: () => Response | Promise<Response>;
  available: () => Response | Promise<Response>;
}): Fetcher =>
  (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('GetUsableModels')) return await routes.usable();
    if (url.includes('AvailableModels')) return await routes.available();
    throw new Error(`unexpected url ${url}`);
  }) as unknown as Fetcher;

const usableModels = (ids: string[]): Response =>
  jsonResponse({ models: ids.map(id => ({ modelId: id, displayName: id })) });

type V = { slug: string; defNonMax?: boolean; defMax?: boolean; effort?: string; thinking?: boolean; fast?: boolean };

// Parsed CursorBaseModel (what buildCollapsedCatalog consumes).
const pbase = (name: string, variants: V[], extra: Partial<CursorBaseModel> = {}): CursorBaseModel => ({
  name,
  displayName: name,
  contextNormal: null,
  contextMax: null,
  reasoning: null,
  variants: variants.map(v => ({
    slug: v.slug,
    legacySlug: v.slug,
    ...(v.effort !== undefined ? { effort: v.effort } : {}),
    ...(v.thinking !== undefined ? { thinking: v.thinking } : {}),
    ...(v.fast !== undefined ? { fast: v.fast } : {}),
    isDefaultNonMaxConfig: v.defNonMax === true,
    isDefaultMaxConfig: v.defMax === true,
  })),
  aliasSlugs: [],
  ...extra,
});

describe('parseContextWindow', () => {
  test('parses k and M suffixes', () => {
    expect(parseContextWindow('**X**<br />200k context window')).toBe(200_000);
    expect(parseContextWindow('300k context window')).toBe(300_000);
    expect(parseContextWindow('1M context window')).toBe(1_000_000);
    expect(parseContextWindow('1.5M context window')).toBe(1_500_000);
  });
  test('returns null when no context phrase is present', () => {
    expect(parseContextWindow('**Auto**<br />Balanced default.')).toBeNull();
    expect(parseContextWindow('')).toBeNull();
  });
});

describe('cursorRawToProviderModel', () => {
  const flags = new Set<string>();
  test('carries context, wire id, and variant ids in providerData', () => {
    const m = cursorRawToProviderModel({ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', contextWindow: 300_000, wireModelId: 'claude-opus-4-8-high', variantIds: ['claude-opus-4-8-high', 'claude-opus-4-8-max'] }, flags);
    expect(m.limits.max_context_window_tokens).toBe(300_000);
    expect(m.providerData).toEqual({ wireModelId: 'claude-opus-4-8-high', variantIds: ['claude-opus-4-8-high', 'claude-opus-4-8-max'] });
  });
  test('no providerData when wire id equals id; 200k fallback', () => {
    const m = cursorRawToProviderModel({ id: 'default', display_name: 'Auto', wireModelId: 'default' }, flags);
    expect(m.providerData).toBeUndefined();
    expect(m.limits.max_context_window_tokens).toBe(200_000);
  });
  test('every model advertises image input; reasoning effort added when present', () => {
    const withReasoning = cursorRawToProviderModel({ id: 'c', display_name: 'c', reasoning: { supported: ['low', 'medium', 'high'], default: 'high' } }, flags);
    expect(withReasoning.chat).toEqual({
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'high' } },
    });
  });
  test('a model with no reasoning still advertises image input', () => {
    expect(cursorRawToProviderModel({ id: 'd', display_name: 'd' }, flags).chat).toEqual({
      modalities: { input: ['text', 'image'], output: ['text'] },
    });
  });
});

describe('cursorWireModelId', () => {
  test('reads providerData.wireModelId, else the id', () => {
    expect(cursorWireModelId({ id: 'claude-opus-4-8', providerData: { wireModelId: 'claude-opus-4-8-high' } } as ProviderModel)).toBe('claude-opus-4-8-high');
    expect(cursorWireModelId({ id: 'gpt-5.5' } as ProviderModel)).toBe('gpt-5.5');
  });
});

describe('resolveCursorWireModel', () => {
  const flags = new Set<string>();
  // thinking + effort model (opus-like)
  const opus = cursorRawToProviderModel({
    id: 'opus', display_name: 'Opus', wireModelId: 'opus-thinking-high',
    variants: [
      { slug: 'opus-low', effort: 'low', thinking: false, fast: false },
      { slug: 'opus-high', effort: 'high', thinking: false, fast: false },
      { slug: 'opus-thinking-low', effort: 'low', thinking: true, fast: false },
      { slug: 'opus-thinking-high', effort: 'high', thinking: true, fast: false },
    ],
  }, flags);
  // thinking-only model (sonnet-4-5-like)
  const sonnet = cursorRawToProviderModel({
    id: 'sonnet', display_name: 'Sonnet', wireModelId: 'sonnet-thinking',
    variants: [{ slug: 'sonnet', thinking: false }, { slug: 'sonnet-thinking', thinking: true }],
  }, flags);
  // effort-only model (gpt-like, incl 'none')
  const gpt = cursorRawToProviderModel({
    id: 'gpt', display_name: 'GPT', wireModelId: 'gpt-high',
    variants: [{ slug: 'gpt-none', effort: 'none' }, { slug: 'gpt-low', effort: 'low' }, { slug: 'gpt-high', effort: 'high' }],
  }, flags);
  // single-variant model (kimi-like)
  const kimi = cursorRawToProviderModel({ id: 'kimi', display_name: 'Kimi', wireModelId: 'kimi', variants: [{ slug: 'kimi' }] }, flags);

  test('no reasoning_effort → default wire', () => {
    expect(resolveCursorWireModel(opus, null)).toBe('opus-thinking-high');
    expect(resolveCursorWireModel(opus, undefined)).toBe('opus-thinking-high');
  });
  test('effort steers effort; thinking stays on for a non-none effort', () => {
    expect(resolveCursorWireModel(opus, 'high')).toBe('opus-thinking-high');
    expect(resolveCursorWireModel(opus, 'low')).toBe('opus-thinking-low');
    expect(resolveCursorWireModel(opus, 'xhigh')).toBe('opus-thinking-high'); // nearest to 'high'
  });
  test("'none' turns thinking off and drops to lowest effort", () => {
    expect(resolveCursorWireModel(opus, 'none')).toBe('opus-low');
  });
  test('thinking-only model toggles thinking by effort presence', () => {
    expect(resolveCursorWireModel(sonnet, 'high')).toBe('sonnet-thinking');
    expect(resolveCursorWireModel(sonnet, 'none')).toBe('sonnet');
    expect(resolveCursorWireModel(sonnet, null)).toBe('sonnet-thinking');
  });
  test('effort-only model maps effort including none', () => {
    expect(resolveCursorWireModel(gpt, 'none')).toBe('gpt-none');
    expect(resolveCursorWireModel(gpt, 'low')).toBe('gpt-low');
    expect(resolveCursorWireModel(gpt, 'medium')).toBe('gpt-low'); // nearest
  });
  test('single-variant model always returns its default', () => {
    expect(resolveCursorWireModel(kimi, 'high')).toBe('kimi');
    expect(resolveCursorWireModel(kimi, 'none')).toBe('kimi');
  });
});

describe('buildCollapsedCatalog', () => {
  const usable: CursorRawModel[] = [
    'claude-opus-4-8-high', 'claude-opus-4-8-max', 'composer-2.5', 'default', 'kimi-k2.5',
  ].map(id => ({ id, display_name: id }));

  const bases = [
    pbase('claude-opus-4-8', [{ slug: 'claude-opus-4-8-high', defNonMax: true }, { slug: 'claude-opus-4-8-max', defMax: true }], {
      displayName: 'Claude Opus 4.8', contextNormal: 300_000, contextMax: 1_000_000,
      reasoning: { supported: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
    }),
    pbase('composer-2.5', [{ slug: 'composer-2.5-fast', defNonMax: true, defMax: true }, { slug: 'composer-2.5' }], { displayName: 'Composer 2.5', contextNormal: 200_000, contextMax: 200_000 }),
    pbase('default', [{ slug: 'default', defNonMax: true, defMax: true }], { displayName: 'Auto' }),
    pbase('phantom', [{ slug: 'phantom-x', defNonMax: true }], { contextNormal: 128_000 }),
  ];

  test('collapses to one model per usable base, carrying metadata (normal mode)', () => {
    const out = buildCollapsedCatalog(usable, bases, false);
    const byId = Object.fromEntries(out.map(r => [r.id, r]));
    expect(out).toHaveLength(4); // 3 collapsed + kimi leftover; phantom dropped

    const opus = byId['claude-opus-4-8'];
    expect(opus.display_name).toBe('Claude Opus 4.8');
    expect(opus.wireModelId).toBe('claude-opus-4-8-high');
    expect(opus.contextWindow).toBe(300_000);
    expect(opus.reasoning).toEqual({ supported: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' });
    expect(opus.variantIds).toEqual(['claude-opus-4-8-high', 'claude-opus-4-8-max']);

    expect(byId['composer-2.5'].wireModelId).toBe('composer-2.5'); // fast not usable → fallback
    expect(byId['kimi-k2.5'].wireModelId).toBeUndefined(); // leftover
  });

  test('max mode picks the default-max variant + max context', () => {
    const opus = buildCollapsedCatalog(usable, bases, true).find(r => r.id === 'claude-opus-4-8')!;
    expect(opus.wireModelId).toBe('claude-opus-4-8-max');
    expect(opus.contextWindow).toBe(1_000_000);
  });
});

// A realistic AvailableModels(useModelParameters) entry.
const tt = (s: string) => ({ markdownContent: s });
const rawEntry = (o: {
  name: string; heading?: string; clientDisplayName?: string;
  ctxEnum?: [string, string]; ctxTooltipNormal?: string; ctxTooltipMax?: string;
  effortId?: 'effort' | 'reasoning'; efforts?: string[]; defaultEffort?: string;
  variants: { slug: string; defNonMax?: boolean; defMax?: boolean }[];
}) => {
  const paramDefs: unknown[] = [];
  if (o.ctxEnum) paramDefs.push({ id: 'context', parameterType: { enumParameter: { values: o.ctxEnum.map(v => ({ value: v })) } } });
  if (o.effortId && o.efforts) paramDefs.push({ id: o.effortId, parameterType: { enumParameter: { values: o.efforts.map(v => ({ value: v })) } } });
  return {
    name: o.name,
    ...(o.clientDisplayName ? { clientDisplayName: o.clientDisplayName } : {}),
    tooltipData: tt(`${o.heading ? `**${o.heading}**<br />` : ''}desc${o.ctxTooltipNormal ? `<br /><br />${o.ctxTooltipNormal} context window` : ''}`),
    tooltipDataForMaxMode: tt(`${o.heading ? `**${o.heading}**<br />` : ''}desc${o.ctxTooltipMax ? `<br /><br />${o.ctxTooltipMax} context window` : ''}`),
    parameterDefinitions: paramDefs,
    variants: o.variants.map(v => ({
      legacySlug: v.slug,
      ...(v.defNonMax ? { isDefaultNonMaxConfig: true } : {}),
      ...(v.defMax ? { isDefaultMaxConfig: true } : {}),
      ...(o.effortId && o.defaultEffort && v.defNonMax ? { parameterValues: [{ id: o.effortId, value: o.defaultEffort }] } : {}),
    })),
  };
};

describe('fetchCursorBaseModels', () => {
  test('uses clientDisplayName for the display name, falling back to the id', async () => {
    const bases = await fetchCursorBaseModels(fetcherOf(() => jsonResponse({
      models: [
        rawEntry({ name: 'claude-opus-4-8', clientDisplayName: 'Opus 4.8', variants: [{ slug: 'claude-opus-4-8-high', defNonMax: true }] }),
        rawEntry({ name: 'gpt-5.2', variants: [{ slug: 'y', defNonMax: true }] }), // no clientDisplayName → id
      ],
    })), noopHeaders);
    const byName = Object.fromEntries(bases.map(b => [b.name, b]));
    expect(byName['claude-opus-4-8'].displayName).toBe('Opus 4.8');
    expect(byName['gpt-5.2'].displayName).toBe('gpt-5.2');
  });

  test('prefers the structured context enum, falls back to tooltip prose', async () => {
    const bases = await fetchCursorBaseModels(fetcherOf(() => jsonResponse({
      models: [
        rawEntry({ name: 'opus', ctxEnum: ['300k', '1m'], ctxTooltipNormal: '999k', ctxTooltipMax: '999k', variants: [{ slug: 'a', defNonMax: true }] }),
        rawEntry({ name: 'gemini', ctxTooltipNormal: '200k', ctxTooltipMax: '1M', variants: [{ slug: 'b', defNonMax: true }] }), // no enum → tooltip
      ],
    })), noopHeaders);
    const byName = Object.fromEntries(bases.map(b => [b.name, b]));
    expect(byName['opus'].contextNormal).toBe(300_000); // enum, not tooltip 999k
    expect(byName['opus'].contextMax).toBe(1_000_000);
    expect(byName['gemini'].contextNormal).toBe(200_000); // tooltip fallback
    expect(byName['gemini'].contextMax).toBe(1_000_000);
  });

  test('recovers a context stated only in the max-mode tooltip (normal tooltip blank)', async () => {
    // gpt-5.3-codex shape: normal tooltip carries no context, max tooltip says 272k.
    const bases = await fetchCursorBaseModels(fetcherOf(() => jsonResponse({
      models: [
        rawEntry({ name: 'codex', ctxTooltipMax: '272k', variants: [{ slug: 'a', defNonMax: true }] }),
      ],
    })), noopHeaders);
    expect(bases[0].contextNormal).toBe(272_000); // recovered from the max tooltip
    expect(bases[0].contextMax).toBe(272_000);
  });

  test('parses reasoning effort enum + default from the default-non-max variant', async () => {
    const bases = await fetchCursorBaseModels(fetcherOf(() => jsonResponse({
      models: [
        rawEntry({ name: 'opus', effortId: 'effort', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', variants: [{ slug: 'a', defNonMax: true }] }),
        rawEntry({ name: 'gpt', effortId: 'reasoning', efforts: ['none', 'low', 'medium', 'high'], variants: [{ slug: 'b', defNonMax: true }] }), // no defaultEffort → 'medium'
        rawEntry({ name: 'kimi', variants: [{ slug: 'c', defNonMax: true }] }), // no effort param → null
      ],
    })), noopHeaders);
    const byName = Object.fromEntries(bases.map(b => [b.name, b]));
    expect(byName['opus'].reasoning).toEqual({ supported: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' });
    expect(byName['gpt'].reasoning).toEqual({ supported: ['none', 'low', 'medium', 'high'], default: 'medium' });
    expect(byName['kimi'].reasoning).toBeNull();
  });
});

describe('fetchCursorCatalog', () => {
  const opts = (fetcher: Fetcher, maxMode?: boolean) => ({ accessToken: 'tok', timezone: 'UTC', fetcher, maxMode });
  const available = () => jsonResponse({
    models: [
      rawEntry({ name: 'claude-opus-4-8', clientDisplayName: 'Opus 4.8', ctxEnum: ['300k', '1m'], effortId: 'effort', efforts: ['low', 'high'], defaultEffort: 'high', variants: [{ slug: 'claude-opus-4-8-high', defNonMax: true }] }),
    ],
  });

  test('collapses with display name, context, reasoning', async () => {
    const raw = await fetchCursorCatalog(opts(routingFetcher({ usable: () => usableModels(['claude-opus-4-8-high']), available })));
    expect(raw).toHaveLength(1);
    const opus = raw[0];
    expect(opus.id).toBe('claude-opus-4-8');
    expect(opus.display_name).toBe('Opus 4.8');
    expect(opus.wireModelId).toBe('claude-opus-4-8-high');
    expect(opus.contextWindow).toBe(300_000);
    expect(opus.reasoning).toEqual({ supported: ['low', 'high'], default: 'high' });
  });

  test('max mode reports the max context', async () => {
    const raw = await fetchCursorCatalog(opts(routingFetcher({ usable: () => usableModels(['claude-opus-4-8-high']), available }), true));
    expect(raw[0].contextWindow).toBe(1_000_000);
  });

  test('falls back to the raw per-variant list when AvailableModels fails', async () => {
    const raw = await fetchCursorCatalog(opts(routingFetcher({ usable: () => usableModels(['claude-opus-4-8-high', 'gpt-5.5-high']), available: () => new Response('nope', { status: 500 }) })));
    expect(raw.map(r => r.id)).toEqual(['claude-opus-4-8-high', 'gpt-5.5-high']);
    expect(raw.every(r => r.wireModelId === undefined && r.reasoning === undefined)).toBe(true);
  });
});
