import { currentHour } from './hour.ts';
import { getRepo } from '../../../repo/index.ts';
import type { TokenUsage, UsageQuantities } from '../../../repo/types.ts';
import { tokenUsageQuantities, usageMetrics } from '../../../repo/usage-metrics.ts';
import { priceRequest, type BillableUsage, type PricingRuntimeFacts } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

const TOKEN_USAGE_KEYS = ['input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image', 'output', 'output_image'] as const satisfies readonly Exclude<keyof TokenUsage, 'tier'>[];
const INPUT_TOKEN_USAGE_KEYS = ['input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image'] as const satisfies readonly Exclude<keyof TokenUsage, 'tier'>[];

// Drop zero / undefined token categories so a usage map only carries the metrics
// actually billed. `tier` (a non-numeric service-tier marker) survives the
// filter so service-tier selector entries resolve at recording time.
export const tokenUsage = (counts: TokenUsage): TokenUsage => {
  const out: TokenUsage = {};
  for (const key of TOKEN_USAGE_KEYS) {
    const value = counts[key] ?? 0;
    if (value > 0) out[key] = value;
  }
  if (counts.tier != null) out.tier = counts.tier;
  return out;
};

// Cache-read / cache-write token counts pulled from an OpenAI-shaped `usage`
// block. The field name and nesting depth vary by upstream; this helper
// hides the variants so the per-API extractors (chat-completions, completions)
// see a single normalized pair regardless of which provider answered.
//
// Cache-read candidates, in order of preference:
//   - `prompt_tokens_details.cached_tokens` — OpenAI canonical (vLLM, llama.cpp,
//     SGLang, Gemini OpenAI-compat, xAI, Mistral, OpenRouter, Groq, Cerebras,
//     Zhipu, Doubao, Qwen main, …).
//   - `prompt_cache_hit_tokens`             — DeepSeek (paired with
//     `prompt_cache_miss_tokens`; `prompt_tokens` is `hit + miss`).
//   - `cached_tokens`                       — Moonshot / Kimi, Cohere v2 native,
//     Qwen Singapore legacy (top-level, no wrapper).
//
// Cache-write candidates, in order of preference:
//   - `prompt_tokens_details.cache_creation_input_tokens` — the Anthropic
//     messages → chat-completions translation pair forwards the native
//     Anthropic field name under OpenAI's wrapper.
//   - `prompt_tokens_details.cache_write_tokens`           — OpenRouter
//     (Anthropic / Gemini-explicit / Alibaba-routed).
//
// Each count is a subset of `prompt_tokens`, so subtracting them in the
// caller recovers the disjoint bare-input metric. Upstreams that report
// no cache fields at all (Together, Perplexity, SiliconFlow, TGI, Ollama-
// compat, plus most providers without a cache layer) fall through to zero,
// leaving the whole prompt count on the bare input bucket.
export interface OpenAICacheTokens {
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

interface OpenAIUsageWithCacheVariants {
  prompt_tokens_details?: {
    cached_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_write_tokens?: unknown;
  };
  prompt_cache_hit_tokens?: unknown;
  cached_tokens?: unknown;
}

export const openAICacheTokensFromUsage = (usage: unknown): OpenAICacheTokens => {
  if (!usage || typeof usage !== 'object') return { cacheRead: 0, cacheWrite: 0 };
  const u = usage as OpenAIUsageWithCacheVariants;
  return {
    cacheRead: firstNumber([u.prompt_tokens_details?.cached_tokens, u.prompt_cache_hit_tokens, u.cached_tokens]),
    cacheWrite: firstNumber([u.prompt_tokens_details?.cache_creation_input_tokens, u.prompt_tokens_details?.cache_write_tokens]),
  };
};

const firstNumber = (candidates: readonly unknown[]): number => {
  for (const candidate of candidates) {
    if (typeof candidate === 'number') return candidate;
  }
  return 0;
};

// Which convention the upstream's own `total_tokens` corroborates, or null
// when the totals cannot separate the two.
//
// OpenAI counts the cache buckets inside the input total; Anthropic counts
// them alongside it, and a gateway projecting an Anthropic-shaped upstream
// onto an OpenAI-shaped wire can carry that convention across. `total_tokens`
// is the one field that witnesses which one the rest of the payload was
// computed under, because only one of the two sums can reach it: with a
// non-zero cache count the inclusive sum and the exclusive sum differ by
// exactly that count, so at most one matches. With no cache count the two
// conventions coincide and there is nothing to decide.
//
// This is a statement about one response, not a classification of the
// upstream. That is enough, because the two conventions agree on every
// response where the verdict is unavailable.
export type CachedTokenConvention = 'inclusive' | 'exclusive';

export const cachedTokenConventionFromTotals = (counts: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number | undefined;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}): CachedTokenConvention | null => {
  const { inputTokens, outputTokens, totalTokens, cacheRead, cacheWrite } = counts;
  const cached = cacheRead + cacheWrite;
  if (totalTokens === undefined || cached === 0) return null;
  const inclusive = inputTokens + outputTokens === totalTokens;
  const exclusive = inputTokens + cached + outputTokens === totalTokens;
  // Neither sum reaching the total means the upstream computes it on some
  // third basis and witnesses nothing.
  if (inclusive === exclusive) return null;
  return inclusive ? 'inclusive' : 'exclusive';
};

export interface CachedTokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number | undefined;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

// Decides whether to fold the cache buckets back into the input total.
//
// Positive evidence folds on its own: a response whose totals witness the
// exclusive convention is repaired whether or not anyone flagged the upstream,
// because the alternative is either a torn stream or an input count silently
// short by the cached prefix. The flag is what settles the responses whose
// totals witness nothing — an upstream that omits `total_tokens` or computes
// it on some third basis.
//
// The two remaining states are both errors, and neither may pass silently.
// Evidence that contradicts the declaration means the flag is set on an
// upstream that does not want it, and folding there over-charges the operator
// for cached input at the full input rate. A cache count larger than the input
// total with nothing to explain it underflows the split downstream regardless;
// raising it here names the flag, which the underflow at the split cannot do
// without the gateway's flag vocabulary leaking into `protocols`.
//
// An upstream that reported the input total exclusively AND recomputed
// `total_tokens` to match it would read as inclusive here and raise even
// though the flag is right for it. No such upstream has been observed: the two
// producers of the exclusive shape both leave a total that witnesses it —
// Portkey sums all four buckets
// (https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/providers/anthropic/chatComplete.ts#L612-L627),
// and Charm Hyper passes the upstream's own total through untouched. Should
// one appear, it announces itself as this error rather than as a wrong bill.
export const foldsExclusiveCacheTokens = (
  declaredExclusive: boolean,
  counts: CachedTokenCounts,
  identity: string,
): boolean => {
  const verdict = cachedTokenConventionFromTotals(counts);
  const cached = counts.cacheRead + counts.cacheWrite;
  const figures = `${identity}: input=${counts.inputTokens} cached=${cached} output=${counts.outputTokens} total=${counts.totalTokens ?? 'absent'}`;

  if (declaredExclusive && verdict === 'inclusive') {
    throw new RangeError(`usage-exclusive-cached-tokens is enabled, but total_tokens says this upstream already counts the cache buckets inside the input total; folding would over-charge input by ${cached} tokens — turn the flag off for ${figures}`);
  }
  if (declaredExclusive || verdict === 'exclusive') return true;
  if (cached > counts.inputTokens) {
    throw new RangeError(`cache counts exceed the input total and total_tokens does not say the cache buckets are reported outside it; if they are, enable usage-exclusive-cached-tokens for ${figures}`);
  }
  return false;
};

export interface UsageMeasurement {
  readonly quantities: UsageQuantities;
  readonly pricingFacts: PricingRuntimeFacts;
  // Dump frames only expose token measurements; duration counts would be
  // mislabeled as tokens in the dump UI.
  readonly dumpTokenUsage: TokenUsage | null;
}

export const requestOnlyUsageMeasurement = (): UsageMeasurement => ({
  quantities: {},
  pricingFacts: {},
  dumpTokenUsage: null,
});

export const tokenUsageMeasurement = (usage: TokenUsage | null): UsageMeasurement => {
  const { tier, ...tokens } = usage ?? {};
  const inputTokens = INPUT_TOKEN_USAGE_KEYS.reduce((sum, key) => sum + (tokens[key] ?? 0), 0);
  return {
    quantities: tokenUsageQuantities(tokens),
    pricingFacts: { serviceTier: tier, inputTokens },
    dumpTokenUsage: usage,
  };
};

// OpenAI Images responses report usage as
// `{input_tokens, output_tokens, total_tokens, input_tokens_details, output_tokens_details}`,
// where the details objects split each total into `text_tokens` and
// `image_tokens`. We map that split onto the billing metrics: bare
// input/output for the text modality, input_image/output_image for the image
// modality. The details splits are disjoint and sum to their respective total.
//
// When a details object is missing but its total is present, the whole total is
// charged on the bare metric rather than inventing a split. A present field
// that is a non-number is treated as a malformed upstream payload (return
// null) rather than silently coerced.
export const tokenUsageFromImagesBody = (body: unknown): TokenUsage | null => {
  if (!body || typeof body !== 'object') return null;
  const { usage } = body as { usage?: unknown };
  if (!usage || typeof usage !== 'object') return null;
  const { input_tokens: inputTotal, output_tokens: outputTotal, input_tokens_details: inputDetails, output_tokens_details: outputDetails } = usage as ImagesUsageShape;

  if (inputTotal !== undefined && typeof inputTotal !== 'number') return null;
  if (outputTotal !== undefined && typeof outputTotal !== 'number') return null;
  if (inputTotal === undefined && outputTotal === undefined) return null;

  const input = splitModalityCounts('input', 'input_image', inputTotal, inputDetails);
  if (input === null) return null;
  const output = splitModalityCounts('output', 'output_image', outputTotal, outputDetails);
  if (output === null) return null;

  return tokenUsage({ ...input, ...output });
};

interface ImagesUsageShape {
  input_tokens?: unknown;
  output_tokens?: unknown;
  input_tokens_details?: unknown;
  output_tokens_details?: unknown;
}

const splitModalityCounts = (
  textUsageKey: Exclude<keyof TokenUsage, 'tier'>,
  imageUsageKey: Exclude<keyof TokenUsage, 'tier'>,
  total: number | undefined,
  details: unknown,
): TokenUsage | null => {
  if (total === undefined) return {};
  if (details === undefined) return { [textUsageKey]: total };
  if (!details || typeof details !== 'object') return null;
  const { text_tokens: text, image_tokens: image } = details as { text_tokens?: unknown; image_tokens?: unknown };
  if (text !== undefined && typeof text !== 'number') return null;
  if (image !== undefined && typeof image !== 'number') return null;
  // A details object that carries neither split is as good as absent.
  if (text === undefined && image === undefined) return { [textUsageKey]: total };
  return { [textUsageKey]: text ?? 0, [imageUsageKey]: image ?? 0 };
};

export const recordUsage = async (
  keyId: string,
  modelIdentity: TelemetryModelIdentity,
  quantities: UsageQuantities,
  pricingFacts: PricingRuntimeFacts,
): Promise<void> => {
  const priced = priceRequest(modelIdentity.pricing, pricingFacts);
  const metrics = usageMetrics(quantities, priced.rates);
  await Promise.all([
    getRepo().usage.record({
      keyId,
      model: modelIdentity.model,
      upstream: modelIdentity.upstream,
      modelKey: modelIdentity.modelKey,
      hour: currentHour(),
      pricingSelector: priced.selector,
      requests: 1,
      metrics,
    }),
    getRepo().apiKeys.update(keyId, { lastUsedAt: new Date().toISOString() }),
  ]);
};

export const recordTokenUsage = async (keyId: string, modelIdentity: TelemetryModelIdentity, usage: TokenUsage | null): Promise<void> => {
  const measurement = tokenUsageMeasurement(usage);
  await recordUsage(keyId, modelIdentity, measurement.quantities, measurement.pricingFacts);
};

// `BillableUsage` is already the canonical exclusive/split shape, so pricing is
// a rename rather than a computation. It is the sole input: the usage Floway
// sends the client is a wire projection and is never read here.
export const tokenUsageFromBillableUsage = (billable: BillableUsage | undefined): TokenUsage | null =>
  billable === undefined ? null : tokenUsage({
    input: billable.input,
    input_cache_read: billable.cacheRead,
    input_cache_write: billable.cacheWrite,
    input_cache_write_1h: billable.cacheWrite1h,
    output: billable.output,
    ...(billable.tier !== undefined ? { tier: billable.tier } : {}),
  });
