import { currentHour } from './hour.ts';
import { getRepo } from '../../../repo/index.ts';
import type { TokenUsage, UsageQuantities } from '../../../repo/types.ts';
import { usageDimensions } from '../../../repo/usage-dimensions.ts';
import { BILLING_DIMENSIONS, INPUT_BILLING_DIMENSIONS, type BillingDimension, type PriceUnits, priceRequest, type PricingRuntimeFacts } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

export const hasTokenUsage = (usage: TokenUsage): boolean => BILLING_DIMENSIONS.some(dimension => usage[dimension] !== undefined);

// Drop zero / undefined dimensions so a usage map only carries the dimensions
// actually billed. `tier` (a non-numeric service-tier marker) survives the
// filter so service-tier selector entries resolve at recording time.
export const tokenUsage = (counts: TokenUsage): TokenUsage => {
  const out: TokenUsage = {};
  for (const dimension of BILLING_DIMENSIONS) {
    const value = counts[dimension];
    if (value !== undefined) out[dimension] = value;
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
// caller recovers the disjoint bare-input dimension. Upstreams that report
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

export const tokenUsageFromEmbeddingsBody = (body: unknown): TokenUsage | null => {
  if (!body || typeof body !== 'object') return null;
  const { usage } = body as { usage?: unknown };
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  return typeof promptTokens === 'number' ? tokenUsage({ input: promptTokens }) : null;
};

export interface UsageMeasurement {
  readonly quantities: UsageQuantities;
  readonly units: PriceUnits;
  readonly pricingFacts: PricingRuntimeFacts;
  // Dump frames predate per-dimension units. Only token measurements populate
  // this compatibility view; duration counts would otherwise be mislabeled as
  // tokens in the dump UI.
  readonly dumpTokenUsage: TokenUsage | null;
}

export const requestOnlyUsageMeasurement = (): UsageMeasurement => ({
  quantities: {},
  units: {},
  pricingFacts: {},
  dumpTokenUsage: null,
});

export const tokenUsageMeasurement = (usage: TokenUsage | null): UsageMeasurement => {
  const { tier, ...tokens } = usage ?? {};
  const inputTokens = INPUT_BILLING_DIMENSIONS.reduce((sum, dimension) => sum + (tokens[dimension] ?? 0), 0);
  const units = Object.fromEntries(
    BILLING_DIMENSIONS.filter(dimension => tokens[dimension] !== undefined).map(dimension => [dimension, 'tokens_1m']),
  ) as PriceUnits;
  return {
    quantities: tokens,
    units,
    pricingFacts: { serviceTier: tier, inputTokens },
    dumpTokenUsage: usage,
  };
};

// OpenAI transcription responses discriminate usage by `type`. Token-based
// models expose independent input/output counts; duration-based models expose
// seconds. We preserve the raw seconds as the quantity and declare the
// denominator as minutes, so price scaling converts seconds without rounding.
// Missing or unknown breakdowns record the request only: total_tokens and a
// top-level duration are never used to invent a provider-owned metric. Once an
// upstream selects a known discriminator, malformed declared fields are a
// protocol violation and must remain observable to the response boundary.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L36378-L36562
export const audioTranscriptionUsageMeasurement = (body: unknown): UsageMeasurement => {
  if (!body || typeof body !== 'object') return requestOnlyUsageMeasurement();
  if (!Object.hasOwn(body, 'usage')) return requestOnlyUsageMeasurement();
  const usage = (body as { usage: unknown }).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new Error('Audio transcription usage must be an object');
  }
  const metric = usage as { type?: unknown; seconds?: unknown; input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown };

  if (metric.type === 'duration') {
    if (typeof metric.seconds !== 'number' || !Number.isFinite(metric.seconds) || metric.seconds < 0) {
      throw new Error('Audio transcription duration usage.seconds must be a finite non-negative number');
    }
    return {
      quantities: { input: metric.seconds },
      units: { input: 'minutes' },
      pricingFacts: {},
      dumpTokenUsage: null,
    };
  }

  if (metric.type !== 'tokens') return requestOnlyUsageMeasurement();
  for (const [field, value] of [
    ['input_tokens', metric.input_tokens],
    ['output_tokens', metric.output_tokens],
    ['total_tokens', metric.total_tokens],
  ] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`Audio transcription token usage.${field} must be a finite non-negative number`);
    }
  }
  const tokens = tokenUsage({
    ...(typeof metric.input_tokens === 'number' ? { input: metric.input_tokens } : {}),
    ...(typeof metric.output_tokens === 'number' ? { output: metric.output_tokens } : {}),
  });
  return tokenUsageMeasurement(tokens);
};

// OpenAI Images responses report usage as
// `{input_tokens, output_tokens, total_tokens, input_tokens_details, output_tokens_details}`,
// where the details objects split each total into `text_tokens` and
// `image_tokens`. We map that split onto the billing dimensions: bare
// input/output for the text modality, input_image/output_image for the image
// modality. The details splits are disjoint and sum to their respective total.
//
// When a details object is missing but its total is present, the whole total is
// charged on the bare dimension rather than inventing a split. A present field
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
  textDimension: BillingDimension,
  imageDimension: BillingDimension,
  total: number | undefined,
  details: unknown,
): TokenUsage | null => {
  if (total === undefined) return {};
  if (details === undefined) return { [textDimension]: total };
  if (!details || typeof details !== 'object') return null;
  const { text_tokens: text, image_tokens: image } = details as { text_tokens?: unknown; image_tokens?: unknown };
  if (text !== undefined && typeof text !== 'number') return null;
  if (image !== undefined && typeof image !== 'number') return null;
  // A details object that carries neither split is as good as absent.
  if (text === undefined && image === undefined) return { [textDimension]: total };
  return { [textDimension]: text ?? 0, [imageDimension]: image ?? 0 };
};

export const recordUsage = async (
  keyId: string,
  modelIdentity: TelemetryModelIdentity,
  quantities: UsageQuantities,
  units: PriceUnits,
  pricingFacts: PricingRuntimeFacts,
  options: { readonly unitMismatch?: 'reject' | 'unpriced' } = {},
): Promise<void> => {
  const priced = priceRequest(modelIdentity.pricing, pricingFacts);
  let applicableRates = priced.rates;
  for (const dimension of BILLING_DIMENSIONS) {
    const pricingUnit = priced.units?.[dimension];
    const usageUnit = units[dimension];
    if (pricingUnit !== undefined && usageUnit !== undefined && pricingUnit !== usageUnit) {
      if (options.unitMismatch !== 'unpriced') {
        throw new Error(`Usage dimension ${dimension} is measured in ${usageUnit} but priced in ${pricingUnit}`);
      }
      if (applicableRates?.[dimension] !== undefined) {
        const { [dimension]: _mismatchedRate, ...matchingRates } = applicableRates;
        applicableRates = matchingRates;
      }
    }
  }
  const dimensions = usageDimensions(quantities, units, applicableRates);
  await Promise.all([
    getRepo().usage.record({
      keyId,
      model: modelIdentity.model,
      upstream: modelIdentity.upstream,
      modelKey: modelIdentity.modelKey,
      hour: currentHour(),
      pricingSelector: priced.selector,
      requests: 1,
      dimensions,
    }),
    (async () => {
      const key = await getRepo().apiKeys.getById(keyId);
      if (!key) return;
      await getRepo().apiKeys.save({
        ...key,
        lastUsedAt: new Date().toISOString(),
      });
    })(),
  ]);
};

export const recordTokenUsage = async (keyId: string, modelIdentity: TelemetryModelIdentity, usage: TokenUsage | null): Promise<void> => {
  const measurement = tokenUsageMeasurement(usage);
  await recordUsage(keyId, modelIdentity, measurement.quantities, measurement.units, measurement.pricingFacts);
};
